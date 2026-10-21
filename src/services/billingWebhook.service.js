/**
 * Billing webhook service (billing roadmap 3.1).
 *
 * PURPOSE
 *   Store-then-process ingestion of payment-provider webhooks:
 *     1. `ingest` verifies `X-Razorpay-Signature` over the exact raw body,
 *        stores ONE event row per `x-razorpay-event-id` (unique index) and
 *        returns at once, so the HTTP handler answers 2xx fast;
 *     2. `processEvent` works from the stored row (lease + attempts) and
 *        `drainDue` retries unfinished rows with exponential backoff (run
 *        by the reconcile job), so a crash or a transient DB error never
 *        loses an event and a redelivery never applies it twice.
 *
 * FORWARD-ONLY
 *   Transaction states only move forward (pending -> authorized ->
 *   captured -> refunded; failed/expired may still be overtaken by a
 *   verified capture), so out-of-order delivery is safe: a late
 *   `payment.failed` or `payment.authorized` after a capture changes
 *   nothing. Access is granted only through `confirmAndApplyCapture`, which
 *   re-fetches the payment server-side and checks order, status, amount and
 *   currency.
 *
 * WHAT IS STORED
 *   The redacted normalised summary (ids, amount, currency, status, event
 *   time) - never the signature or payer details.
 */

import crypto from 'node:crypto';
import ApiError from '../utils/ApiError.js';
import clock from '../utils/clock.js';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import { getProvider, WEBHOOK_EVENT_ALLOWLIST } from './paymentProvider.adapter.js';
import paymentTransactionRepository from '../repositories/paymentTransaction.repository.js';
import webhookEventRepository from '../repositories/webhookEvent.repository.js';
import billingService from './billing.service.js';
import billingLifecycle from './billingLifecycle.service.js';
import { OPEN_STATUSES } from '../models/PaymentTransaction.js';
import { emit as auditEmit } from './auditLog.service.js';

export const PROVIDER = 'razorpay';
export const EVENT_ID_HEADER = 'x-razorpay-event-id';
export const PROCESS_LEASE_MS = 60 * 1000;
export const RETRY_BASE_MS = 30 * 1000;
export const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

const ACTOR = Object.freeze({ type: 'system', id: 'razorpay-webhook' });
const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Processing started off the request path (tests await `waitForIdle`). */
const inFlight = new Set();

export function requireProvider() {
  const provider = getProvider(PROVIDER);
  if (!provider || provider.isImplemented !== true) {
    throw ApiError.notImplemented(
      'No payment provider is selected. Webhook ingestion is not yet available.',
    );
  }
  return provider;
}

function summarize(normalized) {
  return {
    event: normalized.event,
    entityId: normalized.entityId ?? null,
    orderId: normalized.orderId ?? null,
    paymentId: normalized.paymentId ?? null,
    amount: normalized.amount ?? null,
    currency: normalized.currency ?? null,
    status: normalized.status ?? null,
  };
}

/** The dedupe key: Razorpay's event id, else a digest of the exact bytes. */
export function eventIdOf(header, rawBody) {
  const value = typeof header === 'string' ? header.trim() : '';
  if (value && EVENT_ID_RE.test(value)) return value;
  return `sha256:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
}

export function retryDelayMs(attempts) {
  const n = Math.max(0, Number(attempts) || 0);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, n - 1));
}

/**
 * Verify and store one delivery. Throws 401 on a missing or bad signature
 * (nothing stored), 400 on an unparsable body.
 *
 * @returns {Promise<{ eventId: string, duplicate: boolean, event: Object, supported: boolean }>}
 */
export async function ingest({ rawBody, signature, eventIdHeader = null, now = clock.now() } = {}) {
  const provider = requireProvider();
  if (!Buffer.isBuffer(rawBody)) throw ApiError.serviceUnavailable('Webhook raw body unavailable');
  if (!signature || !provider.verifyWebhookSignature(rawBody, signature)) {
    throw ApiError.unauthorized('Invalid webhook signature');
  }
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw ApiError.badRequest('Invalid webhook payload');
  }
  const normalized = provider.normalizeWebhookEvent(payload);
  const eventId = eventIdOf(eventIdHeader, rawBody);
  const { event, duplicate } = await webhookEventRepository.insertOnce({
    provider: PROVIDER,
    eventId,
    eventType: String(normalized.event ?? 'unknown').slice(0, 100),
    raw: summarize(normalized),
    providerCreatedAt: normalized.createdAt ?? null,
    now,
  });
  if (!event) throw ApiError.badRequest('Invalid webhook payload');
  return { eventId, duplicate, event, supported: normalized.supported === true };
}

/** Process a stored event off the request path. */
export function kick(eventRowId) {
  const run = processEvent(eventRowId).catch((err) => {
    logger.warn({ err: { message: err?.message }, op: 'billing.webhook.process' }, 'Webhook processing failed');
  });
  inFlight.add(run);
  run.finally(() => inFlight.delete(run));
  return run;
}

/** Test hook: wait until processing kicked off by `kick` has finished. */
export async function waitForIdle() {
  while (inFlight.size > 0) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.allSettled([...inFlight]);
  }
}

async function findTransaction(summary) {
  if (summary.orderId) {
    const byOrder = await paymentTransactionRepository.findByOrderId(summary.orderId);
    if (byOrder) return byOrder;
  }
  if (summary.paymentId) return paymentTransactionRepository.findByPaymentId(summary.paymentId);
  return null;
}

async function handle(summary, { provider, now }) {
  const txn = await findTransaction(summary);
  if (!txn) return { outcome: 'unknown_order', transaction: null };
  const event = summary.event;

  if (event === 'payment.captured' || event === 'order.paid') {
    // The event body is only a hint: the server-side payment fetch inside
    // confirmAndApplyCapture decides (order, status, amount, currency).
    return billingService.confirmAndApplyCapture({
      transaction: txn,
      paymentId: summary.paymentId,
      provider,
      actor: ACTOR,
      now,
    });
  }

  if (event === 'payment.authorized') {
    // No access on authorized-only; record it (forward-only).
    const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
      to: 'authorized',
      fromStatuses: ['pending'],
      patch: { ...(summary.paymentId ? { providerPaymentId: summary.paymentId } : {}), authorizedAt: now },
    });
    return { outcome: moved ? 'authorized' : `transaction_${txn.status}`, transaction: moved ?? txn };
  }

  if (event === 'payment.failed') {
    // A failed attempt never closes a captured order, and a later verified
    // capture on the same order still wins over this failure.
    const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
      to: 'failed',
      fromStatuses: [...OPEN_STATUSES],
      patch: { failureReason: 'payment_failed', failedAt: now },
    });
    if (!moved) return { outcome: `transaction_${txn.status}`, transaction: txn };
    await billingLifecycle.applyFailure({
      tenantId: String(txn.tenantId),
      providerRef: txn.providerOrderId,
      reason: 'Razorpay payment failed',
      actor: ACTOR,
    });
    return { outcome: 'failed', transaction: moved };
  }

  if (event === 'refund.created' || event === 'refund.processed') {
    if (txn.status === 'refunded') return { outcome: 'already_refunded', transaction: txn };
    const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
      to: 'refunded',
      fromStatuses: ['captured'],
      patch: { refundedAt: now },
    });
    if (!moved) return { outcome: `transaction_${txn.status}`, transaction: txn };
    await billingLifecycle.applyRefund({ tenantId: String(txn.tenantId), providerRef: txn.providerOrderId, actor: ACTOR });
    return { outcome: 'refunded', transaction: moved };
  }

  return { outcome: 'unsupported', transaction: txn };
}

/**
 * Process one stored event. Claims it first, so concurrent processors and
 * redeliveries never run the same event twice. Permanent refusals (4xx,
 * e.g. a suspended tenant) finish the event as `processed` with outcome
 * `refused`: the captured row stays unapplied and reconciliation re-drives
 * it once the tenant is reinstated. Transient failures retry with backoff.
 *
 * @returns {Promise<{ status: string, outcome: string|null }|null>} null when not claimable.
 */
export async function processEvent(eventRowId, { now = clock.now() } = {}) {
  const event = await webhookEventRepository.claim(eventRowId, { now, leaseMs: PROCESS_LEASE_MS });
  if (!event) return null;
  const summary = event.raw ?? {};
  if (!WEBHOOK_EVENT_ALLOWLIST.includes(summary.event)) {
    // Signed but not an event we act on: recorded and acknowledged.
    await webhookEventRepository.finish(event._id, { status: 'ignored', outcome: 'unsupported_event', now });
    return { status: 'ignored', outcome: 'unsupported_event' };
  }

  try {
    // A provider switched off since the delivery is a transient condition
    // (501 is retried like any 5xx).
    const provider = requireProvider();
    const result = await handle(summary, { provider, now });
    const ignored = result.outcome === 'unknown_order' || result.outcome === 'unsupported';
    await webhookEventRepository.finish(event._id, {
      status: ignored ? 'ignored' : 'processed',
      outcome: result.outcome,
      tenantId: result.transaction?.tenantId ? String(result.transaction.tenantId) : null,
      now,
    });
    await auditEmit({
      actor: ACTOR,
      action: ignored ? 'billing.webhook_ignored' : 'billing.webhook_processed',
      module: 'billing.webhooks',
      resource: { type: 'webhook_event', id: event.eventId },
      tenantId: result.transaction?.tenantId ? String(result.transaction.tenantId) : undefined,
      after: { ...summary, outcome: result.outcome },
    }).catch(() => {});
    return { status: ignored ? 'ignored' : 'processed', outcome: result.outcome };
  } catch (err) {
    if (err instanceof ApiError && err.statusCode >= 400 && err.statusCode < 500) {
      await webhookEventRepository.finish(event._id, { status: 'processed', outcome: 'refused', error: err.message, now });
      await auditEmit({
        actor: ACTOR,
        action: 'billing.webhook_refused',
        module: 'billing.webhooks',
        resource: { type: 'webhook_event', id: event.eventId },
        after: { ...summary, refusal: err.message },
      }).catch(() => {});
      logger.warn({ event: summary.event, refusal: err.message }, 'Razorpay webhook refused');
      return { status: 'processed', outcome: 'refused' };
    }
    const giveUp = (event.attempts ?? 1) >= env.billing.webhookMaxAttempts;
    await webhookEventRepository.retryLater(event._id, {
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(event.attempts)),
      error: err?.message ?? 'processing_failed',
      giveUp,
    });
    logger.warn(
      { err: { message: err?.message }, event: summary.event, attempts: event.attempts, giveUp },
      'Razorpay webhook processing failed; will retry',
    );
    return { status: giveUp ? 'failed' : 'retry', outcome: null };
  }
}

/** Retry sweep: process every due, unfinished stored event (bounded). */
export async function drainDue({ now = clock.now(), limit = 50 } = {}) {
  const due = await webhookEventRepository.listDue({ now, limit });
  const counts = { webhooksProcessed: 0, webhooksRetried: 0, webhooksFailed: 0 };
  for (const row of due) {
    // eslint-disable-next-line no-await-in-loop
    const result = await processEvent(row._id, { now }).catch(() => ({ status: 'retry' }));
    if (!result) continue;
    if (result.status === 'processed' || result.status === 'ignored') counts.webhooksProcessed += 1;
    else if (result.status === 'failed') counts.webhooksFailed += 1;
    else counts.webhooksRetried += 1;
  }
  return counts;
}

export default {
  PROVIDER,
  EVENT_ID_HEADER,
  ingest,
  kick,
  waitForIdle,
  processEvent,
  drainDue,
  eventIdOf,
  retryDelayMs,
  _meta: { module: 'billing.webhooks' },
};
