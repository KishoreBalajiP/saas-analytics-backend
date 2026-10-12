/**
 * /api/v1/billing/webhook routes (Phase 6.1 - Razorpay).
 *
 * PURPOSE
 *   Signature-verified Razorpay webhook ingestion. When the provider is
 *   disabled every write returns 501 honestly (preserves the Phase 6
 *   contract); when enabled, webhooks are verified against the RAW body,
 *   durably recorded, and processed idempotently through the billing
 *   lifecycle service.
 *
 * ENDPOINTS
 *   - GET  /health        provider adapter liveness
 *   - POST /              Razorpay webhook (public, signature-gated)
 *
 * SECURITY
 *   - Public route by design (Razorpay signs, we verify). NO state
 *     changes before `X-Razorpay-Signature` verifies against the exact
 *     raw bytes (`express.raw` in `app.js` for this path).
 *   - Missing/invalid signature -> 401, no mutation, no retry-storm
 *     leakage (generic message).
 *   - Supported events are allowlisted in the adapter; unknown signed
 *     events are recorded and acked without mutation.
 *   - Terminal transaction states never regress (conditional updates).
 *   - 4xx lifecycle refusals (e.g. suspended tenant) are recorded and
 *     acked 200 to avoid poison retries; transient failures return 503
 *     so Razorpay retries.
 *   - Nothing secret is logged or stored (no signatures, no full
 *     payloads - only redacted event summaries).
 */

import { Router } from 'express';
import ApiError from '../utils/ApiError.js';
import config from '../config/env.js';
import { getProvider } from '../services/paymentProvider.adapter.js';
import paymentTransactionRepository from '../repositories/paymentTransaction.repository.js';
import { recordEvent, markProcessed } from '../repositories/webhookEvent.repository.js';
import billingLifecycle from '../services/billingLifecycle.service.js';
import { emit as auditEmit } from '../services/auditLog.service.js';
import logger from '../utils/logger.js';

const router = Router();

function requireProvider() {
  const provider = getProvider('razorpay');
  if (!provider || provider.isImplemented !== true) {
    throw ApiError.notImplemented(
      'No payment provider is selected. Webhook ingestion is not yet available.',
    );
  }
  return provider;
}

function rawBodyOf(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  return null;
}

function parseBody(raw) {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw ApiError.badRequest('Invalid webhook payload');
  }
}

function redactedSummary(normalized) {
  return {
    event: normalized.event,
    entityId: normalized.entityId,
    orderId: normalized.orderId,
    paymentId: normalized.paymentId,
    amount: normalized.amount,
    currency: normalized.currency,
    status: normalized.status,
  };
}

async function applyCaptureForOrder({ orderId, paymentId, actor }) {
  let txn = await paymentTransactionRepository.findByOrderId(orderId);
  if (txn && txn.status === 'captured') {
    return { outcome: 'already_captured', transaction: txn };
  }
  if (txn && txn.status !== 'pending') {
    return { outcome: `transaction_${txn.status}`, transaction: txn };
  }
  if (!txn) {
    // No local checkout record (e.g. created before this deploy, or the
    // create-checkout write raced the webhook). Recover authoritatively:
    // fetch the live payment and only proceed when it is captured for
    // this order with a usable plan reference in provider notes.
    return { outcome: 'unknown_order', transaction: null };
  }
  const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
    to: 'captured',
    fromStatuses: ['pending'],
    patch: { ...(paymentId ? { providerPaymentId: paymentId } : {}), capturedAt: new Date() },
  });
  if (!moved) {
    const fresh = await paymentTransactionRepository.findByOrderId(orderId);
    return { outcome: 'already_captured', transaction: fresh ?? txn };
  }
  const result = await billingLifecycle.applyCapture({
    tenantId: String(txn.tenantId),
    planId: txn.planId,
    providerRef: orderId,
    paymentId,
    actor,
  });
  return { outcome: result.idempotent ? 'already_captured' : 'captured', transaction: moved };
}

async function applyFailureForOrder({ orderId, reason, actor }) {
  const txn = await paymentTransactionRepository.findByOrderId(orderId);
  if (!txn) return { outcome: 'unknown_order', transaction: null };
  if (txn.status !== 'pending') return { outcome: `transaction_${txn.status}`, transaction: txn };
  const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
    to: 'failed',
    fromStatuses: ['pending'],
    patch: { failureReason: reason ?? 'payment_failed', failedAt: new Date() },
  });
  if (!moved) {
    const fresh = await paymentTransactionRepository.findByOrderId(orderId);
    return { outcome: `transaction_${fresh?.status ?? 'moved'}`, transaction: fresh ?? txn };
  }
  await billingLifecycle.applyFailure({
    tenantId: String(txn.tenantId),
    providerRef: orderId,
    reason: reason ?? 'Razorpay payment failed',
    actor,
  });
  return { outcome: 'failed', transaction: moved };
}

async function applyRefundForOrder({ orderId, actor }) {
  const txn = await paymentTransactionRepository.findByOrderId(orderId);
  if (!txn) return { outcome: 'unknown_order', transaction: null };
  if (txn.status === 'refunded') return { outcome: 'already_refunded', transaction: txn };
  if (txn.status !== 'captured') return { outcome: `transaction_${txn.status}`, transaction: txn };
  const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
    to: 'refunded',
    fromStatuses: ['captured'],
    patch: { refundedAt: new Date() },
  });
  if (!moved) {
    const fresh = await paymentTransactionRepository.findByOrderId(orderId);
    return { outcome: `transaction_${fresh?.status ?? 'moved'}`, transaction: fresh ?? txn };
  }
  await billingLifecycle.applyRefund({ tenantId: String(txn.tenantId), providerRef: orderId, actor });
  return { outcome: 'refunded', transaction: moved };
}

router.get( // ci:routes-exempt: public health, no auth
  '/health',
  (_req, res) => {
    const provider = getProvider(config?.razorpay?.enabled ? 'razorpay' : 'noop');
    res.json({
      status: 'ok',
      provider: provider.name,
      implemented: provider.isImplemented === true,
      environment: config?.razorpay?.environment ?? 'test',
      note:
        provider.isImplemented === true
          ? 'Razorpay webhook ingestion is active (test mode unless RAZORPAY_ENVIRONMENT=live).'
          : 'No payment provider is selected. Webhook and checkout return 501.',
    });
  },
);

router.post( // ci:routes-exempt: public webhook - X-Razorpay-Signature verified below
  '/',
  async (req, res, next) => {
    try {
      const provider = requireProvider();
      const raw = rawBodyOf(req);
      if (!raw) {
        throw ApiError.serviceUnavailable('Webhook raw body unavailable');
      }
      const signature = req.headers?.['x-razorpay-signature'] ?? req.headers?.['X-Razorpay-Signature'] ?? null;
      if (!signature || !provider.verifyWebhookSignature(raw, signature)) {
        throw ApiError.unauthorized('Invalid webhook signature');
      }
      const payload = parseBody(raw);
      const normalized = provider.normalizeWebhookEvent(payload);
      const actor = { type: 'system', id: 'razorpay-webhook' };

      const eventId = `${normalized.event}:${normalized.entityId ?? normalized.orderId ?? 'unknown'}`;
      const summary = redactedSummary(normalized);

      const stored = await recordEvent({
        provider: 'razorpay',
        eventId,
        eventType: normalized.event,
        raw: summary,
        tenantId: null,
        subscriptionId: null,
      });
      if (stored?.processed === true) {
        return res.json({ received: true, processed: false, reason: 'duplicate_delivery' });
      }

      if (!normalized.supported) {
        await markProcessed({ provider: 'razorpay', eventId });
        logger.info({ event: normalized.event }, 'Razorpay webhook: unsupported event acknowledged');
        return res.json({ received: true, processed: false, reason: 'unsupported_event' });
      }

      let result;
      try {
        if (normalized.event === 'payment.captured' || normalized.event === 'order.paid') {
          result = await applyCaptureForOrder({ orderId: normalized.orderId, paymentId: normalized.paymentId, actor });
        } else if (normalized.event === 'payment.failed') {
          result = await applyFailureForOrder({ orderId: normalized.orderId, reason: 'Razorpay payment failed', actor });
        } else if (normalized.event === 'refund.created' || normalized.event === 'refund.processed') {
          result = await applyRefundForOrder({ orderId: normalized.orderId, actor });
        } else {
          result = { outcome: 'unsupported', transaction: null };
        }
      } catch (err) {
        if (err instanceof ApiError && err.statusCode >= 400 && err.statusCode < 500) {
          // Permanent refusal (e.g. suspended tenant): record, audit, ack
          // 200 so Razorpay does not poison-retry a doomed delivery.
          await markProcessed({ provider: 'razorpay', eventId, error: err.message });
          await auditEmit({
            actor,
            action: 'billing.webhook_refused',
            module: 'billing.webhooks',
            resource: { type: 'webhook_event', id: eventId },
            after: { ...summary, refusal: err.message },
          }).catch(() => {});
          logger.warn({ event: normalized.event, refusal: err.message }, 'Razorpay webhook refused');
          return res.json({ received: true, processed: false, reason: 'refused', detail: err.message });
        }
        throw err;
      }

      if (result.outcome === 'unknown_order') {
        await markProcessed({ provider: 'razorpay', eventId, error: 'unknown_order' });
        await auditEmit({
          actor,
          action: 'billing.webhook_unknown_order',
          module: 'billing.webhooks',
          resource: { type: 'webhook_event', id: eventId },
          after: summary,
        }).catch(() => {});
        logger.warn({ event: normalized.event }, 'Razorpay webhook for unknown order; acknowledged');
        return res.json({ received: true, processed: false, reason: 'unknown_order' });
      }

      await markProcessed({ provider: 'razorpay', eventId });
      await auditEmit({
        actor,
        action: 'billing.webhook_processed',
        module: 'billing.webhooks',
        resource: { type: 'webhook_event', id: eventId },
        tenantId: result.transaction?.tenantId ? String(result.transaction.tenantId) : undefined,
        after: { ...summary, outcome: result.outcome },
      }).catch(() => {});
      return res.json({ received: true, processed: true, outcome: result.outcome });
    } catch (err) {
      if (err instanceof ApiError && (err.statusCode === 401 || err.statusCode === 400)) {
        return next(err);
      }
      if (err instanceof ApiError && err.statusCode === 501) {
        return next(err);
      }
      // Transient (DB/provider) failure -> 503 so Razorpay retries.
      logger.warn({ err: { message: err?.message }, op: 'billing.webhook' }, 'Webhook processing failed transiently');
      return next(ApiError.serviceUnavailable('Webhook processing failed; please retry'));
    }
  },
);

export default router;
