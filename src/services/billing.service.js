/**
 * Billing orchestration service (Phase 6.1 - Razorpay one-time order flow).
 *
 * PURPOSE
 *   Coordinates checkout creation and checkout verification between the
 *   pricing authority, the provider adapter, the pending-transaction
 *   store and the lifecycle service. The controller stays thin; this
 *   service owns the cross-cutting rules.
 *
 * RULES
 *   - Plan identity/amount/currency come from `billingPricing` (server
 *     config). Client-supplied prices are never read.
 *   - A repeat checkout for the same tenant+plan+price while one is
 *     pending returns the existing pending order (no duplicate provider
 *     orders, safe under double-click).
 *   - Verification is authoritative: HMAC signature + live payment fetch
 *     (status/amount/currency/order association) before any lifecycle
 *     call. Browser callbacks alone never activate anything.
 *   - Every transition is idempotent (transaction conditional-update +
 *     lifecycle guards), so verify/webhook/reconcile can all run.
 */

import crypto from 'node:crypto';
import ApiError from '../utils/ApiError.js';
import planService from './plan.service.js';
import tenantRepository from '../repositories/tenant.repository.js';
import subscriptionService from './subscription.service.js';
import billingPricing from './billingPricing.service.js';
import billingLifecycle from './billingLifecycle.service.js';
import { getProvider } from './paymentProvider.adapter.js';
import paymentTransactionRepository from '../repositories/paymentTransaction.repository.js';
import { emit as auditEmit } from './auditLog.service.js';
import logger from '../utils/logger.js';

function requireProvider() {
  const provider = getProvider('razorpay');
  if (!provider || provider.isImplemented !== true) {
    throw ApiError.notImplemented(
      'Checkout is not yet available. Contact support to change plans.',
    );
  }
  return provider;
}

function newReceipt(tenantId) {
  const rand = crypto.randomBytes(6).toString('hex');
  return `rzp_${String(tenantId).slice(-8)}_${Date.now().toString(36)}_${rand}`;
}

/**
 * Create (or reuse) a pending checkout for `tenantId` -> `planCode`.
 * Returns ONLY public checkout fields for the frontend.
 */
export async function createCheckout({ tenantId, planCode, actor = null, by = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!planCode) throw ApiError.badRequest('planId is required');

  const plan = await planService.getActiveByCode(planCode);
  if (!plan) throw ApiError.badRequest(`Plan "${planCode}" is not available`);
  if (plan.code === 'free') throw ApiError.badRequest('Free plan does not require checkout');

  const price = billingPricing.resolvePrice(plan.code);
  const provider = requireProvider();

  // Ensure a subscription row exists (lazy provisioning on the tenant's
  // CURRENT plan - never on the checkout target, or every checkout for a
  // different plan would look like a no-op same-plan request).
  let sub = await subscriptionService.getForTenant(tenantId);
  if (!sub) {
    const tenant = await tenantRepository.findById(tenantId);
    const current = tenant?.planId ? await planService.getActiveByCode(tenant.planId) : null;
    const seedPlan = current ?? (await planService.resolveFallbackPlan());
    sub = await subscriptionService.createForTenant({
      tenantId,
      planId: seedPlan.code,
      state: 'active',
      actor: actor ?? { type: 'system', id: 'system' },
      by,
      reason: 'Lazy provisioning before checkout',
    });
  }
  if (sub.planId === plan.code && sub.state === 'active') {
    throw ApiError.conflict(`Tenant is already on plan "${plan.code}"`);
  }

  // Idempotent reuse: an equivalent pending attempt wins over a new order.
  const existing = await paymentTransactionRepository.findPendingForTenantPlan({
    tenantId,
    planId: plan.code,
    amountMinor: price.amountMinor,
    currency: price.currency,
  });
  if (existing) {
    return {
      transactionId: String(existing._id),
      orderId: existing.providerOrderId,
      keyId: provider.keyId,
      amountMinor: existing.amountMinor,
      currency: existing.currency,
      planId: existing.planId,
      reused: true,
    };
  }

  const receipt = newReceipt(tenantId);
  let order;
  try {
    order = await provider.createOrder({
      amountMinor: price.amountMinor,
      currency: price.currency,
      receipt,
      notes: { tenantId: String(tenantId), planId: plan.code },
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw ApiError.serviceUnavailable('Payment provider is temporarily unavailable');
  }

  if (!order?.id || order.amount !== price.amountMinor || String(order.currency).toUpperCase() !== price.currency) {
    logger.warn({ op: 'billing.createCheckout' }, 'Provider order mismatch; aborting checkout');
    throw ApiError.serviceUnavailable('Payment provider returned an inconsistent order');
  }

  let txn;
  try {
    txn = await paymentTransactionRepository.create(
      {
        tenantId: String(tenantId),
        planId: plan.code,
        amountMinor: price.amountMinor,
        currency: price.currency,
        provider: 'razorpay',
        providerOrderId: order.id,
        receipt,
        status: 'pending',
      },
      { by },
    );
  } catch (err) {
    // Duplicate order id (provider retried / race): reuse the stored row.
    const dup = await paymentTransactionRepository.findByOrderId(order.id);
    if (dup) {
      return {
        transactionId: String(dup._id),
        orderId: dup.providerOrderId,
        keyId: provider.keyId,
        amountMinor: dup.amountMinor,
        currency: dup.currency,
        planId: dup.planId,
        reused: true,
      };
    }
    throw err;
  }

  await auditEmit({
    actor: actor ?? { type: 'system', id: 'system' },
    action: 'billing.checkout_created',
    module: 'billing.payments',
    resource: { type: 'payment_transaction', id: String(txn._id) },
    tenantId: String(tenantId),
    after: { planId: plan.code, amountMinor: price.amountMinor, currency: price.currency, orderId: order.id },
  });

  return {
    transactionId: String(txn._id),
    orderId: order.id,
    keyId: provider.keyId,
    amountMinor: price.amountMinor,
    currency: price.currency,
    planId: plan.code,
    reused: false,
  };
}

/**
 * Verify a completed Razorpay Checkout. Authoritative: signature +
 * live payment entity must agree with the stored transaction before the
 * lifecycle service runs. Idempotent.
 */
export async function verifyCheckout({ tenantId, orderId, paymentId, signature, actor = null, by = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!orderId || !paymentId || !signature) {
    throw ApiError.badRequest('razorpay_order_id, razorpay_payment_id and razorpay_signature are required');
  }
  const provider = requireProvider();
  const who = actor ?? { type: 'user', id: by ?? 'unknown' };

  const txn = await paymentTransactionRepository.findByOrderId(orderId);
  if (!txn || String(txn.tenantId) !== String(tenantId)) {
    throw ApiError.notFound('No matching pending checkout for this workspace');
  }
  if (txn.status === 'captured') {
    const sub = await subscriptionService.getForTenant(tenantId);
    return { verified: true, idempotent: true, subscription: sub, transactionId: String(txn._id) };
  }
  if (txn.status !== 'pending') {
    throw ApiError.conflict(`Checkout is already ${txn.status}; contact support`);
  }

  if (!provider.verifyCheckoutSignature({ orderId, paymentId, signature })) {
    await paymentTransactionRepository.transitionStatus(txn._id, {
      to: 'failed',
      fromStatuses: ['pending'],
      patch: { failureReason: 'signature_mismatch', failedAt: new Date() },
      by,
    });
    throw ApiError.badRequest('Payment signature verification failed');
  }

  let payment;
  try {
    payment = await provider.fetchPayment(paymentId);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw ApiError.serviceUnavailable('Payment provider is temporarily unavailable');
  }

  const associated = payment.order_id === orderId;
  const amountOk = payment.amount === txn.amountMinor;
  const currencyOk = String(payment.currency).toUpperCase() === String(txn.currency).toUpperCase();
  const paidOk = payment.status === 'captured' || (payment.status === 'authorized' && payment.captured === true);
  if (!associated || !amountOk || !currencyOk || !paidOk) {
    await paymentTransactionRepository.transitionStatus(txn._id, {
      to: 'failed',
      fromStatuses: ['pending'],
      patch: {
        failureReason: !associated
          ? 'payment_order_mismatch'
          : !amountOk || !currencyOk
            ? 'payment_amount_mismatch'
            : `payment_status_${payment.status}`,
        failedAt: new Date(),
      },
      by,
    });
    throw ApiError.badRequest('Payment could not be verified with the provider');
  }

  const done = await paymentTransactionRepository.transitionStatus(txn._id, {
    to: 'captured',
    fromStatuses: ['pending'],
    patch: { providerPaymentId: paymentId, capturedAt: new Date() },
    by,
  });
  if (!done) {
    // Lost a race with a webhook/reconcile that already captured it.
    const sub = await subscriptionService.getForTenant(tenantId);
    return { verified: true, idempotent: true, subscription: sub, transactionId: String(txn._id) };
  }

  const result = await billingLifecycle.applyCapture({
    tenantId: String(tenantId),
    planId: txn.planId,
    providerRef: orderId,
    paymentId,
    actor: who,
  });

  await auditEmit({
    actor: who,
    action: 'billing.payment_verified',
    module: 'billing.payments',
    resource: { type: 'payment_transaction', id: String(txn._id) },
    tenantId: String(tenantId),
    after: { planId: txn.planId, orderId, paymentId },
  });

  const sub = await subscriptionService.getForTenant(tenantId);
  return { verified: true, idempotent: result.idempotent === true, subscription: sub, transactionId: String(txn._id) };
}

export default {
  createCheckout,
  verifyCheckout,
  _meta: { module: 'billing.checkout' },
};
