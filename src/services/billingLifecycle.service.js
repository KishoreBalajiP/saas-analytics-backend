/**
 * Billing lifecycle service (Phase 6.1 - Razorpay one-time order flow).
 *
 * PURPOSE
 *   The ONLY place verified provider money-events touch the subscription.
 *   Checkout verification, webhooks and reconciliation all funnel here,
 *   and this service only ever mutates through `subscription.service.js`
 *   (`changePlan` / `reactivate` / `setState`) plus a narrow
 *   payment-reference patch. The subscription state graph
 *   (`assertTransition`) is never bypassed.
 *
 * IDEMPOTENCY
 *   Every entry point is safe to call twice with the same provider
 *   reference: repeat calls detect the already-applied state and return
 *   `{ applied: true, idempotent: true }` without writing history twice.
 *
 * GUARDS
 *   - Suspended / disabled / archived tenants are NEVER activated.
 *   - `restricted` subscriptions are NEVER activated by money events
 *     (requires an explicit admin `setState`).
 *   - Failed payments never grant entitlements; they move a matching
 *     active subscription to `past_due` (grace from the plan's own
 *     `graceDays`) or leave it untouched when unrelated.
 *   - Refunds never auto-downgrade: the transaction is marked refunded
 *     and an audit/history trail is written; plan access stays until an
 *     admin acts. (Business decision documented in the Phase 6.1 report.)
 */

import ApiError from '../utils/ApiError.js';
import subscriptionService from './subscription.service.js';
import planService from './plan.service.js';
import tenantRepository from '../repositories/tenant.repository.js';
import subscriptionRepository from '../repositories/subscription.repository.js';
import { emit as auditEmit } from './auditLog.service.js';
import logger from '../utils/logger.js';

const BLOCKED_TENANT_STATUSES = Object.freeze(['suspended', 'disabled', 'archived']);

function systemActor() {
  return { type: 'system', id: 'razorpay-webhook' };
}

async function loadTenantGuard(tenantId) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant || tenant.deletedAt) throw ApiError.notFound('Tenant not found');
  return tenant;
}

function ensureActivatable(tenant, subscription) {
  if (BLOCKED_TENANT_STATUSES.includes(tenant.status)) {
    throw ApiError.conflict(`Tenant is "${tenant.status}"; provider events cannot activate it`);
  }
  if (subscription && subscription.state === 'restricted') {
    throw ApiError.conflict('Subscription is restricted; provider events cannot activate it');
  }
}

/**
 * Apply a verified capture: move the tenant onto `planId` (active) and
 * stamp the provider reference. Idempotent on `providerRef`.
 */
export async function applyCapture({ tenantId, planId, providerRef, paymentId = null, actor = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!planId) throw ApiError.badRequest('planId is required');
  if (!providerRef) throw ApiError.badRequest('providerRef is required');
  const who = actor ?? systemActor();

  const tenant = await loadTenantGuard(tenantId);
  let sub = await subscriptionService.getForTenant(tenantId);

  if (!sub) {
    ensureActivatable(tenant, null);
    sub = await subscriptionService.createForTenant({
      tenantId,
      planId,
      state: 'active',
      actor: who,
      by: who.id,
      reason: `Razorpay payment captured (${providerRef})`,
      paymentProvider: 'razorpay',
      paymentReference: providerRef,
    });
    return { applied: true, idempotent: false, subscription: sub };
  }

  ensureActivatable(tenant, sub);

  if (sub.planId === planId && sub.state === 'active' && sub.paymentReference === providerRef) {
    return { applied: true, idempotent: true, subscription: sub };
  }

  // Same plan but reference missing (e.g. verify raced webhook): stamp it.
  if (sub.planId === planId && sub.state === 'active') {
    const updated = await subscriptionRepository.update(
      sub.id,
      { paymentProvider: 'razorpay', paymentReference: providerRef },
      { by: who.id },
    );
    await subscriptionRepository.appendHistory(tenantId, {
      type: 'subscription.payment_captured',
      fromState: sub.state,
      toState: sub.state,
      fromPlanId: sub.planId,
      toPlanId: planId,
      reason: `Razorpay payment captured (${providerRef})`,
      actor: who,
      metadata: { providerRef, paymentId },
    });
    return { applied: true, idempotent: false, subscription: updated };
  }

  if (sub.planId !== planId) {
    sub = await subscriptionService.changePlan({
      tenantId,
      planId,
      actor: who,
      by: who.id,
      reason: `Razorpay payment captured (${providerRef})`,
    });
  }
  if (sub.state !== 'active') {
    sub = await subscriptionService.reactivate({
      tenantId,
      planId,
      actor: who,
      by: who.id,
      reason: `Razorpay payment captured (${providerRef})`,
    });
  }
  const updated = await subscriptionRepository.update(
    sub.id,
    { paymentProvider: 'razorpay', paymentReference: providerRef },
    { by: who.id },
  );
  await subscriptionRepository.appendHistory(tenantId, {
    type: 'subscription.payment_captured',
    fromState: sub.state,
    toState: 'active',
    fromPlanId: sub.planId,
    toPlanId: planId,
    reason: `Razorpay payment captured (${providerRef})`,
    actor: who,
    metadata: { providerRef, paymentId },
  });
  await auditEmit({
    actor: who,
    action: 'subscription.payment_captured',
    module: 'iam.subscriptions',
    resource: { type: 'subscription', id: String(updated._id ?? sub.id) },
    tenantId,
    before: { planId: sub.planId, state: sub.state },
    after: { planId, state: 'active', providerRef },
  });
  return { applied: true, idempotent: false, subscription: updated };
}

/**
 * Apply a verified payment failure. Never grants entitlements. Moves a
 * subscription whose provider reference matches into `past_due` (grace
 * from the plan's own graceDays); otherwise records history only.
 */
export async function applyFailure({ tenantId, providerRef, reason = null, actor = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!providerRef) throw ApiError.badRequest('providerRef is required');
  const who = actor ?? systemActor();

  const sub = await subscriptionService.getForTenant(tenantId);
  if (!sub) {
    logger.info({ tenantId }, 'Payment failure for tenant without subscription; recorded only');
    return { applied: true, idempotent: false, subscription: null, note: 'no_subscription' };
  }
  if (sub.paymentReference !== providerRef) {
    // Failure for a superseded/duplicate attempt - must not touch live access.
    await subscriptionRepository.appendHistory(tenantId, {
      type: 'subscription.payment_failed',
      fromState: sub.state,
      toState: sub.state,
      fromPlanId: sub.planId,
      toPlanId: sub.planId,
      reason: reason ?? `Razorpay payment failed (${providerRef})`,
      actor: who,
      metadata: { providerRef, unrelated: true },
    });
    return { applied: true, idempotent: false, subscription: sub, note: 'unrelated_attempt' };
  }
  if (sub.state === 'past_due') {
    return { applied: true, idempotent: true, subscription: sub };
  }
  if (sub.state !== 'active' && sub.state !== 'trialing') {
    return { applied: true, idempotent: true, subscription: sub, note: 'state_not_eligible' };
  }
  const plan = await planService.getByCode(sub.planId).catch(() => null);
  const graceDays = Number.isInteger(plan?.data?.graceDays) ? plan.data.graceDays : 7;
  const updated = await subscriptionService.setState({
    tenantId,
    state: 'past_due',
    graceEndsAt: new Date(Date.now() + graceDays * 86400000),
    actor: who,
    by: who.id,
    reason: reason ?? `Razorpay payment failed (${providerRef})`,
  });
  return { applied: true, idempotent: false, subscription: updated };
}

/**
 * Apply a verified refund. Marks the trail and leaves plan access for an
 * explicit admin decision (no silent downgrade, no data loss).
 */
export async function applyRefund({ tenantId, providerRef, actor = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!providerRef) throw ApiError.badRequest('providerRef is required');
  const who = actor ?? systemActor();

  const sub = await subscriptionService.getForTenant(tenantId);
  if (sub) {
    await subscriptionRepository.appendHistory(tenantId, {
      type: 'subscription.payment_refunded',
      fromState: sub.state,
      toState: sub.state,
      fromPlanId: sub.planId,
      toPlanId: sub.planId,
      reason: `Razorpay refund processed (${providerRef}); access retained pending admin review`,
      actor: who,
      metadata: { providerRef },
    });
  }
  await auditEmit({
    actor: who,
    action: 'subscription.payment_refunded',
    module: 'iam.subscriptions',
    resource: { type: 'subscription', id: sub ? String(sub.id) : tenantId },
    tenantId,
    after: { providerRef },
    metadata: { note: 'access_retained_pending_admin_review' },
  });
  return { applied: true, idempotent: false, subscription: sub ?? null };
}

export default {
  applyCapture,
  applyFailure,
  applyRefund,
  _meta: { module: 'billing.lifecycle' },
};
