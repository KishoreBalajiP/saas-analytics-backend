/**
 * Billing orchestration service (Phase 6.1; billing roadmap 3.1 prepaid terms).
 *
 * PURPOSE
 *   Coordinates checkout creation, the browser's checkout callback, the
 *   safe capture of provider-confirmed payments and the workspace billing
 *   history between the pricing authority, the provider adapter, the
 *   transaction store and the lifecycle service. Controllers stay thin.
 *
 * RULES
 *   - Plan identity, term and amount come from the plan catalogue /
 *     server configuration (`billingPricing`). Client-supplied prices are
 *     never read.
 *   - A repeat checkout for the same tenant + plan + term + price while one
 *     is open returns the existing order (no duplicate provider orders).
 *   - Paid access is granted ONLY after the provider confirmed the capture:
 *     a verified webhook (or the reconcile sweep, for lost webhooks) plus a
 *     server-side payment fetch through the adapter that agrees on order,
 *     status `captured`, amount and currency (`confirmAndApplyCapture`).
 *     The browser callback (`verifyCheckout`) checks the signature and
 *     reports status; it never grants anything by itself.
 *   - `authorized` payments grant nothing (finding bil.12).
 *   - Transaction states only move forward; a verified capture may still
 *     override `failed` / `expired` on the same order (Razorpay Checkout
 *     retries payments on one order, finding bil.05).
 */

import crypto from 'node:crypto';
import ApiError from '../utils/ApiError.js';
import clock from '../utils/clock.js';
import planService from './plan.service.js';
import subscriptionService from './subscription.service.js';
import billingPricing from './billingPricing.service.js';
import billingLifecycle from './billingLifecycle.service.js';
import { getProvider } from './paymentProvider.adapter.js';
import paymentTransactionRepository from '../repositories/paymentTransaction.repository.js';
import { CAPTURABLE_STATUSES, OPEN_STATUSES } from '../models/PaymentTransaction.js';
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

async function providerCaptureForOrder(provider, orderId, expected) {
  const order = await provider.fetchOrder(orderId);
  const paid = order?.status === 'paid' || (Number(order?.amount_paid ?? 0) > 0 && Number(order?.amount_due ?? 0) === 0);
  if (!paid) return null;
  const payments = await provider.fetchOrderPayments(orderId);
  return payments.find((payment) =>
    payment?.status === 'captured' &&
    payment?.captured === true &&
    Number(payment.amount) === Number(expected.amountMinor) &&
    String(payment.currency ?? '').toUpperCase() === String(expected.currency).toUpperCase(),
  ) ?? null;
}

/** Reconcile open orders before a workspace starts a different checkout. */
async function reconcileOpenForSwitch({ tenantId, targetPlanCode, provider, actor, now = clock.now() }) {
  const open = await paymentTransactionRepository.listOpenForTenant(tenantId);
  let cancelled = 0;
  for (const txn of open) {
    if (txn.planId === targetPlanCode) continue;
    const captured = await providerCaptureForOrder(provider, txn.providerOrderId, txn);
    if (captured) {
      await confirmAndApplyCapture({ transaction: txn, paymentId: captured.id, provider, actor, now });
      throw ApiError.conflict('A previous payment completed. Refresh billing before choosing another plan.');
    }
    if (txn.status !== 'pending') {
      throw ApiError.conflict('An existing payment is still being processed. Check its status before choosing another plan.');
    }
    const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
      to: 'cancelled',
      fromStatuses: ['pending'],
      patch: { cancelledAt: now, failureReason: 'superseded_by_new_checkout' },
      by: actor?.id ?? null,
    });
    if (moved) {
      cancelled += 1;
      await auditEmit({
        actor: actor ?? { type: 'system', id: 'billing' },
        action: 'billing.checkout_cancelled',
        module: 'billing.payments',
        resource: { type: 'payment_transaction', id: String(txn._id) },
        tenantId: String(tenantId),
        after: { reason: 'superseded_by_new_checkout', replacedByPlan: targetPlanCode },
      }).catch(() => {});
    }
  }
  return cancelled;
}

export async function reconcileBeforePlanSwitch({ tenantId, targetPlanCode, actor = null, by = null } = {}) {
  if ((await paymentTransactionRepository.listOpenForTenant(tenantId)).length === 0) return 0;
  return reconcileOpenForSwitch({
    tenantId,
    targetPlanCode,
    provider: requireProvider(),
    actor: actor ?? { type: 'user', id: by ?? 'unknown' },
  });
}

function publicCheckout(txn, provider, reused) {
  return {
    transactionId: String(txn._id),
    orderId: txn.providerOrderId,
    keyId: provider.keyId,
    amountMinor: txn.amountMinor,
    currency: txn.currency,
    planId: txn.planId,
    interval: txn.interval ?? 'month',
    termMonths: txn.termMonths ?? 1,
    environment: provider.environment ?? null,
    reused,
  };
}

/** Public, secret-free view of a transaction for the workspace. */
export function shapeTransaction(txn) {
  if (!txn) return null;
  return {
    id: String(txn._id),
    planId: txn.planId,
    interval: txn.interval ?? 'month',
    termMonths: txn.termMonths ?? 1,
    amountMinor: txn.amountMinor,
    currency: txn.currency,
    provider: txn.provider,
    orderId: txn.providerOrderId,
    paymentId: txn.providerPaymentId ?? null,
    status: txn.status,
    applied: Boolean(txn.appliedAt),
    failureReason: txn.failureReason ?? null,
    createdAt: txn.createdAt ?? null,
    authorizedAt: txn.authorizedAt ?? null,
    capturedAt: txn.capturedAt ?? null,
    appliedAt: txn.appliedAt ?? null,
    failedAt: txn.failedAt ?? null,
    refundedAt: txn.refundedAt ?? null,
    expiredAt: txn.expiredAt ?? null,
    cancelledAt: txn.cancelledAt ?? null,
  };
}

/**
 * Create (or reuse) an open checkout for one prepaid term of `planCode`.
 * Returns ONLY public checkout fields for the frontend.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.planCode
 * @param {'month'|'year'} [params.interval='month']
 */
export async function createCheckout({ tenantId, planCode, interval = 'month', actor = null, by = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!planCode) throw ApiError.badRequest('planId is required');

  const plan = await planService.getActiveByCode(planCode);
  if (!plan) throw ApiError.badRequest(`Plan "${planCode}" is not available`);
  if (planService.isFreePlan(plan)) throw ApiError.badRequest('Free plan does not require checkout');

  const price = billingPricing.resolvePlanPrice(plan, interval);
  const provider = requireProvider();

  // Provision the default subscription (free, or the tenant's trial) so the
  // term is applied against a known state. Never on the checkout target.
  const sub = await subscriptionService.ensureForTenant({
    tenantId,
    actor: actor ?? { type: 'system', id: 'system' },
    by,
    reason: 'Provisioning before checkout',
  });
  if (sub.adminHold === true && sub.state === 'restricted') {
    throw ApiError.conflict('This workspace is on an administrative hold; contact support to change plans');
  }
  if (sub.scheduledChange?.source === 'payment' && sub.scheduledChange.planId !== plan.code) {
    throw ApiError.conflict('A prepaid term for another plan is already queued; contact support to change it');
  }

  // Idempotent reuse: an equivalent open attempt wins over a new order.
  const existing = await paymentTransactionRepository.findPendingForTenantPlan({
    tenantId,
    planId: plan.code,
    amountMinor: price.amountMinor,
    currency: price.currency,
  });
  if (existing && (existing.interval ?? 'month') === price.interval) {
    return publicCheckout(existing, provider, true);
  }

  await reconcileOpenForSwitch({
    tenantId,
    targetPlanCode: plan.code,
    provider,
    actor: actor ?? { type: 'user', id: by ?? 'unknown' },
  });

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
        interval: price.interval,
        termMonths: price.termMonths,
        nextReconcileAt: new Date(clock.now().getTime() + 5 * 60 * 1000),
      },
      { by },
    );
  } catch (err) {
    // Duplicate order id (provider retried / race): reuse the stored row.
    const dup = await paymentTransactionRepository.findByOrderId(order.id);
    if (dup) return publicCheckout(dup, provider, true);
    throw err;
  }

  await auditEmit({
    actor: actor ?? { type: 'system', id: 'system' },
    action: 'billing.checkout_created',
    module: 'billing.payments',
    resource: { type: 'payment_transaction', id: String(txn._id) },
    tenantId: String(tenantId),
    after: {
      planId: plan.code,
      interval: price.interval,
      amountMinor: price.amountMinor,
      currency: price.currency,
      orderId: order.id,
    },
  });

  return publicCheckout(txn, provider, false);
}

/** Abandon an unpaid workspace checkout after checking its provider state. */
export async function cancelCheckout({ tenantId, orderId, actor = null, by = null, now = clock.now() } = {}) {
  if (!tenantId || !orderId) throw ApiError.badRequest('tenantId and orderId are required');
  const txn = await paymentTransactionRepository.findByOrderId(orderId);
  if (!txn || String(txn.tenantId) !== String(tenantId)) {
    throw ApiError.notFound('No matching checkout for this workspace');
  }
  if (txn.status === 'cancelled') return shapeTransaction(txn);
  if (txn.status !== 'pending') {
    throw ApiError.conflict('This checkout is already being processed and cannot be abandoned safely.');
  }
  const provider = requireProvider();
  const captured = await providerCaptureForOrder(provider, txn.providerOrderId, txn);
  if (captured) {
    await confirmAndApplyCapture({ transaction: txn, paymentId: captured.id, provider, actor: actor ?? { type: 'user', id: by ?? 'unknown' }, now });
    throw ApiError.conflict('This payment completed while it was being checked. Refresh billing to see the result.');
  }
  const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
    to: 'cancelled',
    fromStatuses: ['pending'],
    patch: { cancelledAt: now, failureReason: 'abandoned_by_workspace' },
    by,
  });
  if (!moved) throw ApiError.conflict('Checkout changed while it was being abandoned; refresh billing.');
  await auditEmit({
    actor: actor ?? { type: 'user', id: by ?? 'unknown' },
    action: 'billing.checkout_cancelled',
    module: 'billing.payments',
    resource: { type: 'payment_transaction', id: String(txn._id) },
    tenantId: String(tenantId),
    after: { reason: 'abandoned_by_workspace' },
  }).catch(() => {});
  return shapeTransaction(moved);
}

/**
 * Safe capture (findings bil.05 / bil.12): confirm with the provider that
 * `paymentId` is CAPTURED for this transaction's order with the stored
 * amount and currency, move the row to `captured` (forward-only, may
 * override failed/expired), then apply its term through the lifecycle
 * service. Idempotent; a row already captured is only (re-)applied.
 *
 * @returns {Promise<{ outcome: string, transaction: object|null }>}
 *   outcome: captured | already_captured | authorized | not_captured |
 *            order_mismatch | amount_mismatch | transaction_refunded
 */
export async function confirmAndApplyCapture({ transaction, paymentId, provider = null, actor = null, now = clock.now() } = {}) {
  const txn = transaction;
  if (!txn) return { outcome: 'unknown_order', transaction: null };
  const who = actor ?? { type: 'system', id: 'billing' };

  if (txn.status === 'cancelled') return { outcome: 'transaction_cancelled', transaction: txn };
  if (txn.status === 'refunded') return { outcome: 'transaction_refunded', transaction: txn };
  if (txn.status === 'captured') {
    await billingLifecycle.applyCapture({ transaction: txn, actor: who, now });
    return { outcome: 'already_captured', transaction: await paymentTransactionRepository.findById(txn._id) };
  }
  if (!paymentId) return { outcome: 'not_captured', transaction: txn };

  const live = provider ?? requireProvider();
  const payment = await live.fetchPayment(paymentId);
  if (payment?.order_id !== txn.providerOrderId) {
    await auditEmit({
      actor: who,
      action: 'billing.capture_rejected',
      module: 'billing.payments',
      resource: { type: 'payment_transaction', id: String(txn._id) },
      tenantId: String(txn.tenantId),
      after: { reason: 'payment_order_mismatch', orderId: txn.providerOrderId },
    }).catch(() => {});
    return { outcome: 'order_mismatch', transaction: txn };
  }
  const amountOk = Number(payment.amount) === Number(txn.amountMinor);
  const currencyOk = String(payment.currency ?? '').toUpperCase() === String(txn.currency).toUpperCase();
  if (!amountOk || !currencyOk) {
    // Never grant a term for a payment that does not match the order.
    const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
      to: 'failed',
      fromStatuses: [...OPEN_STATUSES],
      patch: { failureReason: 'payment_amount_mismatch', failedAt: now },
    });
    await auditEmit({
      actor: who,
      action: 'billing.capture_rejected',
      module: 'billing.payments',
      resource: { type: 'payment_transaction', id: String(txn._id) },
      tenantId: String(txn.tenantId),
      after: { reason: 'payment_amount_mismatch', orderId: txn.providerOrderId },
    }).catch(() => {});
    logger.warn({ orderId: txn.providerOrderId, op: 'billing.capture' }, 'Payment amount/currency mismatch; capture rejected');
    return { outcome: 'amount_mismatch', transaction: moved ?? txn };
  }
  if (payment.status === 'authorized' && payment.captured !== true) {
    // Authorized only: no access until the provider reports the capture.
    const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
      to: 'authorized',
      fromStatuses: ['pending'],
      patch: { providerPaymentId: paymentId, authorizedAt: now },
    });
    return { outcome: 'authorized', transaction: moved ?? txn };
  }
  if (payment.status !== 'captured') return { outcome: 'not_captured', transaction: txn };

  const moved = await paymentTransactionRepository.transitionStatus(txn._id, {
    to: 'captured',
    fromStatuses: [...CAPTURABLE_STATUSES],
    patch: { providerPaymentId: paymentId, capturedAt: now, failureReason: null },
  });
  const row = moved ?? (await paymentTransactionRepository.findById(txn._id));
  if (!row || row.status !== 'captured') return { outcome: `transaction_${row?.status ?? 'moved'}`, transaction: row };
  await billingLifecycle.applyCapture({ transaction: row, actor: who, now });
  return {
    outcome: moved ? 'captured' : 'already_captured',
    transaction: await paymentTransactionRepository.findById(txn._id),
  };
}

/**
 * The browser's checkout callback. Verifies the checkout signature and
 * that the order belongs to this workspace, then reports the status the
 * server holds. It NEVER grants access: the term is applied only after the
 * verified webhook (or reconciliation) confirms the capture with the
 * provider. The UI polls `getCheckoutStatus` until then.
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
    throw ApiError.notFound('No matching checkout for this workspace');
  }
  if (!provider.verifyCheckoutSignature({ orderId, paymentId, signature })) {
    await auditEmit({
      actor: who,
      action: 'billing.checkout_signature_rejected',
      module: 'billing.payments',
      resource: { type: 'payment_transaction', id: String(txn._id) },
      tenantId: String(tenantId),
      after: { orderId },
    }).catch(() => {});
    throw ApiError.badRequest('Payment signature verification failed');
  }
  const stamped = await paymentTransactionRepository.transitionStatus(txn._id, {
    to: txn.status,
    fromStatuses: [txn.status],
    patch: {
      clientVerifiedAt: clock.now(),
      // Pull the next provider check forward: the webhook may be late.
      ...(OPEN_STATUSES.includes(txn.status) ? { nextReconcileAt: clock.now() } : {}),
    },
    by,
  });
  const status = await getCheckoutStatus({ tenantId, orderId, transaction: stamped ?? txn });
  return { verified: true, ...status };
}

/**
 * Workspace view of one checkout: `pending_confirmation` until the
 * provider-confirmed capture is applied, then `confirmed`.
 */
export async function getCheckoutStatus({ tenantId, orderId, transaction = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const txn = transaction ?? (await paymentTransactionRepository.findByOrderId(orderId));
  if (!txn || String(txn.tenantId) !== String(tenantId)) {
    throw ApiError.notFound('No matching checkout for this workspace');
  }
  let phase = 'pending_confirmation';
  if (txn.status === 'captured' && txn.appliedAt) phase = 'confirmed';
  else if (txn.status === 'captured') phase = 'applying';
  else if (txn.status === 'failed') phase = 'failed';
  else if (txn.status === 'expired') phase = 'expired';
  else if (txn.status === 'cancelled') phase = 'cancelled';
  else if (txn.status === 'refunded') phase = 'refunded';
  const subscription = await subscriptionService.getForTenant(tenantId);
  return { phase, transaction: shapeTransaction(txn), subscription };
}

/** Workspace billing history (payment transactions, newest first). */
export async function listTransactionsForTenant(tenantId, { page = 1, limit = 20 } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const result = await paymentTransactionRepository.listForTenant(tenantId, { page, limit });
  return { ...result, docs: result.docs.map(shapeTransaction) };
}

export default {
  createCheckout,
  cancelCheckout,
  reconcileBeforePlanSwitch,
  verifyCheckout,
  getCheckoutStatus,
  confirmAndApplyCapture,
  listTransactionsForTenant,
  shapeTransaction,
  _meta: { module: 'billing.checkout' },
};
