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
 * LIFECYCLE
 *   pending -> captured | failed | refunded
 *   captured -> refunded
 *   Terminal states (captured/failed/refunded) never regress. `refunded`
 *   is terminal for the transaction; the subscription itself is left for
 *   an explicit admin decision (documented in the Phase 6.1 report).
 *
 * PLUGINS
 *   optimisticConcurrency, paginate, audit (module `billing.payments`).
 *
 * INDEXES
 *   - unique(providerOrderId)
 *   - { tenantId: 1, status: 1, createdAt: -1 }  (pending lookup, reconcile)
 *   - { status: 1, updatedAt: 1 }                (reconcile sweep)
 */

import mongoose from 'mongoose';
import { paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'PaymentTransaction';

export const TRANSACTION_STATUSES = Object.freeze(['pending', 'captured', 'failed', 'refunded']);

export const TERMINAL_TRANSACTION_STATUSES = Object.freeze(['captured', 'failed', 'refunded']);

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
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

paymentTransactionSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
paymentTransactionSchema.index({ status: 1, updatedAt: 1 });

paymentTransactionSchema.plugin(paginate);
paymentTransactionSchema.plugin(optimisticConcurrency);
paymentTransactionSchema.plugin(audit, { module: 'billing.payments' });

export const PaymentTransactionSchema = paymentTransactionSchema;
export const PaymentTransaction =
  mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, paymentTransactionSchema);
export default PaymentTransaction;
