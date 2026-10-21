/**
 * Billing reconciliation service (Phase 6.1; billing roadmap 3.1).
 *
 * PURPOSE
 *   Recovery for missed webhooks, stuck checkouts and half-applied
 *   captures. Runs on a schedule (`billingReconcile.job.js`) and on
 *   operator demand (`POST /admin/subscriptions/reconcile`). Every action is
 *   idempotent: forward-only conditional updates + the apply claim mean a
 *   second run is always a no-op.
 *
 * ONE SWEEP
 *   1. Open checkouts (`pending` / `authorized`) are checked against the
 *      provider in order of their NEXT CHECK (`nextReconcileAt`), each with
 *      its own exponential backoff - so a pile of abandoned checkouts can
 *      never block newer paid ones at the head of the queue (finding
 *      bil.11).
 *        - order paid: find the captured payment of the order and run the
 *          safe capture (`billing.confirmAndApplyCapture`: server-side
 *          payment fetch, amount/currency/order checks);
 *        - not paid: back off; a `pending` row older than
 *          `BILLING_PENDING_EXPIRE_HOURS`, or past `MAX_ATTEMPTS` checks,
 *          is moved to `expired` (a later verified capture still wins).
 *   2. Captured-but-unapplied rows are re-applied (findings bil.05/db.03).
 *   3. Unfinished stored webhook events are retried (`billingWebhook`).
 *   Structured counters are returned and logged (ids only).
 */

import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import clock from '../utils/clock.js';
import { getProvider } from './paymentProvider.adapter.js';
import paymentTransactionRepository from '../repositories/paymentTransaction.repository.js';
import billingService from './billing.service.js';
import billingLifecycle from './billingLifecycle.service.js';
import billingWebhookService from './billingWebhook.service.js';
import logger from '../utils/logger.js';
import { emit as auditEmit } from './auditLog.service.js';

export const DEFAULT_BATCH_LIMIT = 25;
export const MAX_BATCH_LIMIT = 100;
/** Provider checks after which an unpaid `pending` checkout is expired. */
export const MAX_ATTEMPTS = 10;

const ACTOR = Object.freeze({ type: 'system', id: 'billing-reconcile' });

function requireProvider() {
  const provider = getProvider('razorpay');
  if (!provider || provider.isImplemented !== true) {
    throw ApiError.notImplemented('Reconciliation requires an enabled payment provider.');
  }
  return provider;
}

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_BATCH_LIMIT;
  return Math.min(n, MAX_BATCH_LIMIT);
}

/** Next provider check after `attempts` checks (exponential, capped). */
export function backoffMs(attempts) {
  const base = env.billing.reconcileBackoffBaseMs;
  const max = env.billing.reconcileBackoffMaxMs;
  return Math.min(max, base * 2 ** Math.max(0, Number(attempts) || 0));
}

function emptyCounters() {
  return {
    checked: 0,
    captured: 0,
    failed: 0,
    stale: 0,
    skipped: 0,
    expired: 0,
    reapplied: 0,
    errors: 0,
    webhooksProcessed: 0,
    webhooksRetried: 0,
    webhooksFailed: 0,
  };
}

/**
 * Sweep open transactions, re-apply captured ones, retry stored webhooks.
 * Single-flight per process (the scheduler lock covers other processes).
 */
let running = false;

export async function reconcilePending({ limit = DEFAULT_BATCH_LIMIT, by = null, now = clock.now() } = {}) {
  const provider = requireProvider();
  const batch = clampLimit(limit);
  if (running) {
    return { ok: false, reason: 'already_running', ...emptyCounters() };
  }
  running = true;
  const counters = emptyCounters();
  try {
    const open = await paymentTransactionRepository.listOpenDue({ now, limit: batch });
    for (const txn of open) {
      counters.checked += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await reconcileOne({ provider, txn, by, now });
        counters[outcome] = (counters[outcome] ?? 0) + 1;
      } catch (err) {
        counters.errors += 1;
        await paymentTransactionRepository
          .scheduleNextCheck(txn._id, { nextReconcileAt: new Date(now.getTime() + backoffMs(txn.reconcileAttempts)), by })
          .catch(() => {});
        logger.warn(
          { orderId: txn.providerOrderId, err: { message: err?.message } },
          'Billing reconcile: transaction error',
        );
      }
    }

    const unapplied = await paymentTransactionRepository.listCapturedUnapplied({ now, limit: batch });
    for (const txn of unapplied) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await billingLifecycle.applyCapture({ transaction: txn, actor: ACTOR, now });
        if (result.applied && !result.idempotent) counters.reapplied += 1;
      } catch (err) {
        counters.errors += 1;
        logger.warn({ orderId: txn.providerOrderId, err: { message: err?.message } }, 'Billing reconcile: re-apply failed');
      }
    }

    const hooks = await billingWebhookService.drainDue({ now, limit: batch });
    Object.assign(counters, hooks);
  } finally {
    running = false;
  }
  logger.info({ ...counters, op: 'billing.reconcile' }, 'Billing reconcile sweep complete');
  return { ok: true, ...counters };
}

async function expireIfStale(txn, { by, now }) {
  const ageMs = now.getTime() - new Date(txn.createdAt ?? now).getTime();
  const tooOld = ageMs >= env.billing.pendingExpireHours * 3600 * 1000;
  const tooMany = (txn.reconcileAttempts ?? 0) + 1 >= MAX_ATTEMPTS;
  if (txn.status !== 'pending' || (!tooOld && !tooMany)) return false;
  const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
    to: 'expired',
    fromStatuses: ['pending'],
    patch: { expiredAt: now, failureReason: tooOld ? 'checkout_abandoned' : 'reconcile_attempts_exhausted' },
    by,
  });
  return Boolean(moved);
}

async function reconcileOne({ provider, txn, by, now }) {
  const next = () => paymentTransactionRepository.scheduleNextCheck(txn._id, {
    nextReconcileAt: new Date(now.getTime() + backoffMs((txn.reconcileAttempts ?? 0) + 1)),
    by,
  });

  let order;
  try {
    order = await provider.fetchOrder(txn.providerOrderId);
  } catch (err) {
    if (await expireIfStale(txn, { by, now })) return 'expired';
    await next();
    if (err instanceof ApiError && err.statusCode === 404) return 'stale';
    return 'skipped';
  }

  const paid = Number(order.amount_paid ?? 0);
  const due = Number(order.amount_due ?? order.amount ?? 0);
  const orderPaid = order.status === 'paid' || (paid > 0 && due === 0);

  if (!orderPaid) {
    // No money moved yet. The customer may still pay (Checkout retries on
    // the same order); an old or over-checked pending row is expired.
    if (await expireIfStale(txn, { by, now })) return 'expired';
    await next();
    return 'skipped';
  }

  if (Number(order.amount ?? 0) !== Number(txn.amountMinor)) {
    await next();
    await auditEmit({
      actor: ACTOR,
      action: 'billing.reconcile_amount_mismatch',
      module: 'billing.payments',
      resource: { type: 'payment_transaction', id: String(txn._id) },
      tenantId: String(txn.tenantId),
      after: { orderId: txn.providerOrderId },
    }).catch(() => {});
    return 'skipped';
  }

  // Money moved: find the captured payment and run the safe capture, which
  // re-fetches the payment and checks order, status, amount and currency.
  let paymentId = txn.providerPaymentId ?? null;
  if (typeof provider.fetchOrderPayments === 'function') {
    const payments = await provider.fetchOrderPayments(txn.providerOrderId);
    const captured = (payments ?? []).find((p) => p.status === 'captured');
    if (captured) paymentId = captured.id;
  }
  if (!paymentId) {
    await next();
    return 'skipped';
  }
  const result = await billingService.confirmAndApplyCapture({ transaction: txn, paymentId, provider, actor: ACTOR, now });
  if (result.outcome === 'captured' || result.outcome === 'already_captured') {
    await paymentTransactionRepository.scheduleNextCheck(txn._id, { nextReconcileAt: null, by, incrementAttempts: false });
    return 'captured';
  }
  if (result.outcome === 'amount_mismatch' || result.outcome === 'order_mismatch') return 'failed';
  await next();
  return 'skipped';
}

/**
 * Re-drive unprocessed stored webhook events (bounded). Kept for the admin
 * surface; the reconcile sweep calls the same drain.
 */
export async function reprocessWebhooks({ limit = DEFAULT_BATCH_LIMIT, now = clock.now() } = {}) {
  requireProvider();
  const result = await billingWebhookService.drainDue({ now, limit: clampLimit(limit) });
  return { ok: true, ...result };
}

export default {
  reconcilePending,
  reprocessWebhooks,
  backoffMs,
  DEFAULT_BATCH_LIMIT,
  MAX_BATCH_LIMIT,
  MAX_ATTEMPTS,
  _meta: { module: 'billing.reconcile' },
};
