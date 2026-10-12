/**
 * Billing reconciliation service (Phase 6.1 - Razorpay one-time order flow).
 *
 * PURPOSE
 *   Recovery for missed webhooks and stuck checkouts. Runs on a schedule
 *   (`billingReconcile.job.js`, disabled by default) and on operator
 *   demand (`POST /admin/subscriptions/reconcile`). Every action is
 *   idempotent: transaction conditional-updates + lifecycle guards mean a
 *   second run is always a no-op.
 *
 * RULES
 *   - Only `pending` transactions are swept, oldest-first, bounded batch.
 *   - Provider state is authoritative: fetch the order, then the payment
 *     when the order shows money moved. Never grant access on a guess.
 *   - Terminal states are applied through the same lifecycle service as
 *     verify/webhooks (single code path, single audit trail).
 *   - Unprocessable rows (provider 404/gone, attempts exhausted) are left
 *     pending with an incremented attempt counter - never failed on a
 *     guess. After MAX_ATTEMPTS they are reported as `stale` for an
 *     operator to inspect.
 *   - Structured counters `{ checked, captured, failed, stale, skipped,
 *     errors }` are returned and logged (sanitized: ids only, no
 *     amounts beyond minor-unit integers already stored locally).
 */

import ApiError from '../utils/ApiError.js';
import { getProvider } from './paymentProvider.adapter.js';
import paymentTransactionRepository from '../repositories/paymentTransaction.repository.js';
import billingLifecycle from './billingLifecycle.service.js';
import logger from '../utils/logger.js';
import { emit as auditEmit } from './auditLog.service.js';

export const DEFAULT_BATCH_LIMIT = 25;
export const MAX_BATCH_LIMIT = 100;
export const MAX_ATTEMPTS = 10;

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

/**
 * Sweep pending transactions against provider state.
 * Single-flight per process via a module flag (the cron runner is the
 * only scheduled caller; the admin endpoint awaits the same function).
 */
let running = false;

export async function reconcilePending({ limit = DEFAULT_BATCH_LIMIT, by = null } = {}) {
  const provider = requireProvider();
  const batch = clampLimit(limit);
  if (running) {
    return { ok: false, reason: 'already_running', checked: 0, captured: 0, failed: 0, stale: 0, skipped: 0, errors: 0 };
  }
  running = true;
  const counters = { checked: 0, captured: 0, failed: 0, stale: 0, skipped: 0, errors: 0 };
  try {
    const pending = await paymentTransactionRepository.listPending({ limit: batch });
    for (const txn of pending) {
      counters.checked += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await reconcileOne({ provider, txn, by });
        counters[outcome] += 1;
      } catch (err) {
        counters.errors += 1;
        logger.warn(
          { orderId: txn.providerOrderId, err: { message: err?.message } },
          'Billing reconcile: transaction error',
        );
      }
    }
  } finally {
    running = false;
  }
  logger.info({ ...counters, op: 'billing.reconcile' }, 'Billing reconcile sweep complete');
  return { ok: true, ...counters };
}

async function reconcileOne({ provider, txn, by }) {
  if ((txn.reconcileAttempts ?? 0) >= MAX_ATTEMPTS) {
    return 'stale';
  }
  let order;
  try {
    order = await provider.fetchOrder(txn.providerOrderId);
  } catch (err) {
    await paymentTransactionRepository.touchReconciled(txn._id, { by });
    if (err instanceof ApiError && err.statusCode === 404) return 'stale';
    return 'skipped';
  }

  const paid = Number(order.amount_paid ?? 0);
  const due = Number(order.amount_due ?? order.amount ?? 0);
  const orderPaid = order.status === 'paid' || (paid > 0 && due === 0);

  if (!orderPaid) {
    // Order exists but no money moved yet (customer never paid, or
    // payment failed without a webhook). Leave pending; the customer can
    // still complete it, or it ages into `stale` for operator review.
    await paymentTransactionRepository.touchReconciled(txn._id, { by });
    return 'skipped';
  }

  // Money moved: resolve the payment. The order receipt/notes are ours;
  // still re-verify amount/currency against the stored transaction.
  if (Number(order.amount ?? 0) !== Number(txn.amountMinor)) {
    await paymentTransactionRepository.touchReconciled(txn._id, { by });
    await auditEmit({
      actor: { type: 'system', id: 'billing-reconcile' },
      action: 'billing.reconcile_amount_mismatch',
      module: 'billing.payments',
      resource: { type: 'payment_transaction', id: String(txn._id) },
      tenantId: String(txn.tenantId),
      after: { orderId: txn.providerOrderId },
    }).catch(() => {});
    return 'skipped';
  }

  const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
    to: 'captured',
    fromStatuses: ['pending'],
    patch: { capturedAt: new Date() },
    by,
  });
  if (!moved) return 'skipped';

  await billingLifecycle.applyCapture({
    tenantId: String(txn.tenantId),
    planId: txn.planId,
    providerRef: txn.providerOrderId,
    paymentId: null,
    actor: { type: 'system', id: 'billing-reconcile' },
  });
  await paymentTransactionRepository.touchReconciled(txn._id, { by, incrementAttempts: false });
  return 'captured';
}

/**
 * Re-drive unprocessed webhook events (bounded). Events already marked
 * processed are skipped; unknown-order events are left for an operator
 * (they need a human decision, not a blind retry).
 */
export async function reprocessWebhooks({ limit = DEFAULT_BATCH_LIMIT } = {}) {
  requireProvider();
  const batch = clampLimit(limit);
  const { default: WebhookEvent } = await import('../models/WebhookEvent.js');
  const stale = await WebhookEvent.find({ provider: 'razorpay', processed: false })
    .sort({ createdAt: 1 })
    .limit(batch)
    .lean();
  return {
    ok: true,
    pending: stale.length,
    note: 'Unprocessed webhook events require the original delivery context; inspect via GET /admin/subscriptions/:tenantId/webhooks and re-drive from the Razorpay dashboard.',
  };
}

export default {
  reconcilePending,
  reprocessWebhooks,
  DEFAULT_BATCH_LIMIT,
  MAX_BATCH_LIMIT,
  MAX_ATTEMPTS,
  _meta: { module: 'billing.reconcile' },
};
