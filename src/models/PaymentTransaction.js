/**
 * PaymentTransaction (Phase 6.1 - Razorpay one-time order flow).
 *
 * PURPOSE
 *   Durable record of a single provider checkout attempt for a tenant.
 *   This is the idempotency and association anchor for checkout
 *   verification, webhooks and reconciliation: every state change
 *   (verify/webhook/reconcile) resolves the transaction first and only
 *   mutates the subscription through `billingLifecycle.service.js`.
 *
 * LIFECYCLE (billing, roadmap 3.1: forward-only)
 *   pending -> authorized -> captured -> refunded
 *   pending | authorized -> failed | expired
 *   failed | expired -> captured   (Razorpay Checkout retries on the same
 *                                   order; a later verified capture wins)
 *   `captured` and `refunded` never regress. `authorized` grants nothing.
 *   A captured row is only "done" once `appliedAt` is set: the lifecycle
 *   change is applied after the capture flip and re-driven (webhook retry
 *   sweep, reconcile) until it succeeds, so a crash between the two can
 *   never leave a paid-but-not-upgraded tenant. `applyingUntil` is the
 *   short claim that keeps two processors from applying the same term.
 *   `refunded` is terminal for the transaction; the subscription itself is
 *   left for an explicit admin decision.
 *
 * PLUGINS
 *   optimisticConcurrency, paginate, audit (module `billing.payments`).
 *
 * INDEXES
 *   - unique(providerOrderId)
 *   - { tenantId: 1, status: 1, createdAt: -1 }  (pending lookup, reconcile)
 *   - { status: 1, updatedAt: 1 }                (reconcile sweep)
 *   - { status: 1, nextReconcileAt: 1 }          (reconcile order + backoff)
 *   - { status: 1, appliedAt: 1 }                (captured-but-unapplied)
 */

import mongoose from 'mongoose';
import { paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'PaymentTransaction';

export const TRANSACTION_STATUSES = Object.freeze([
  'pending', 'authorized', 'captured', 'failed', 'refunded',
  // billing: an abandoned checkout aged out by reconciliation.
  'expired',
]);

export const TERMINAL_TRANSACTION_STATUSES = Object.freeze(['captured', 'failed', 'refunded', 'expired']);

/** billing: statuses a verified capture may still move from. */
export const CAPTURABLE_STATUSES = Object.freeze(['pending', 'authorized', 'failed', 'expired']);

/** billing: statuses reconciliation keeps checking against the provider. */
export const OPEN_STATUSES = Object.freeze(['pending', 'authorized']);

const paymentTransactionSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    planId: { type: String, required: true, index: true },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, trim: true, uppercase: true },
    provider: { type: String, enum: ['razorpay'], required: true, default: 'razorpay', index: true },
    providerOrderId: { type: String, required: true, unique: true, index: true, trim: true },
    providerPaymentId: { type: String, default: null, trim: true, index: true },
    receipt: { type: String, required: true, trim: true },
    status: { type: String, enum: [...TRANSACTION_STATUSES], default: 'pending', index: true },
    failureReason: { type: String, default: null, trim: true },
    capturedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    lastReconciledAt: { type: Date, default: null },
    reconcileAttempts: { type: Number, default: 0, min: 0 },
    // billing (roadmap 3.1): prepaid term bought by this order.
    interval: { type: String, enum: ['month', 'year'], default: 'month' },
    termMonths: { type: Number, default: 1, min: 1 },
    authorizedAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    clientVerifiedAt: { type: Date, default: null },
    appliedAt: { type: Date, default: null },
    applyingUntil: { type: Date, default: null },
    applyError: { type: String, default: null, trim: true },
    nextReconcileAt: { type: Date, default: () => new Date() },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

paymentTransactionSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
paymentTransactionSchema.index({ status: 1, updatedAt: 1 });
// billing: reconcile picks open rows by next check, and re-drives captured
// rows whose lifecycle change is not applied yet.
paymentTransactionSchema.index({ status: 1, nextReconcileAt: 1 });
paymentTransactionSchema.index({ status: 1, appliedAt: 1 });

paymentTransactionSchema.plugin(paginate);
paymentTransactionSchema.plugin(optimisticConcurrency);
paymentTransactionSchema.plugin(audit, { module: 'billing.payments' });

export const PaymentTransactionSchema = paymentTransactionSchema;
export const PaymentTransaction =
  mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, paymentTransactionSchema);
export default PaymentTransaction;
