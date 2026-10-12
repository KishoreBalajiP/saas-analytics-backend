/**
 * Subscription controller (Phase 6 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for the workspace-facing subscription surface.
 *   All inputs come from `req.validated`; tenant identity always comes
 *   from `req.tenantId` (set by the tenant isolation middleware).
 *
 * RESPONSIBILITY
 *   - getSubscription, getTimeline
 *   - cancelSubscription
 *   - changePlan
 *   - reactivate
 *
 * CODING GUIDELINES
 *   - The controller never accepts a `tenantId` from the request
 *     body or a query parameter; the `:id` URL parameter is the
 *     only tenant source, and the tenant isolation middleware
 *     rejects mismatches.
 *   - Plan changes write through the canonical subscription
 *     service which is the only place the state graph is enforced.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import subscriptionService from '../services/subscription.service.js';
import planService from '../services/plan.service.js';
import billingService from '../services/billing.service.js';
import billingPricing from '../services/billingPricing.service.js';

function actorOf(req) {
  if (req.user) return { type: 'user', id: req.user.id };
  if (req.admin) return { type: 'admin', id: req.admin.id };
  return { type: 'system', id: 'system' };
}

function attribution(req) {
  if (req.user?.id) return req.user.id;
  if (req.admin?.id) return req.admin.id;
  return null;
}

function resolveTenantId(req) {
  // The :id param is the canonical tenant for the workspace routes
  // (mounted under /tenants/:id/...). Cross-tenant access is rejected
  // by the tenant isolation middleware that is applied at mount time.
  const fromParam = req.params?.id ?? null;
  if (fromParam) return String(fromParam);
  return req.tenant?.id ?? req.user?.tenantId ?? req.admin?.tenantId ?? null;
}

export const getSubscription = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  let sub = await subscriptionService.getForTenant(tenantId);
  if (!sub) {
    const tenantPlan = req.tenant?.planId ?? null;
    let plan = tenantPlan ? await planService.getActiveByCode(tenantPlan) : null;
    if (!plan) plan = await planService.resolveFallbackPlan();
    sub = await subscriptionService.createForTenant({
      tenantId,
      planId: plan.code,
      state: 'active',
      actor: actorOf(req),
      by: attribution(req),
      reason: 'Lazy provisioning on first read',
    });
  }
  return ApiResponse.ok(res, sub, 'Subscription fetched');
});

export const getTimeline = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const { page, limit } = req.validated?.query ?? {};
  const result = await subscriptionService.listForTenant(tenantId, {
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, result.docs, 'Subscription timeline fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

export const cancelSubscription = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const { reason, immediate } = req.validated?.body ?? {};
  let sub = await subscriptionService.getForTenant(tenantId);
  if (!sub) {
    const tenantPlan = req.tenant?.planId ?? null;
    let plan = tenantPlan ? await planService.getActiveByCode(tenantPlan) : null;
    if (!plan) plan = await planService.resolveFallbackPlan();
    sub = await subscriptionService.createForTenant({
      tenantId,
      planId: plan.code,
      state: 'active',
      actor: actorOf(req),
      by: attribution(req),
      reason: 'Lazy provisioning on first mutation',
    });
  }
  sub = await subscriptionService.cancel({
    tenantId,
    actor: actorOf(req),
    by: attribution(req),
    immediate: immediate === true,
    reason: reason ?? null,
  });
  return ApiResponse.ok(res, sub, 'Subscription canceled');
});

export const changePlan = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const { planId, reason } = req.validated?.body ?? {};
  const plan = await planService.getActiveByCode(planId);
  if (!plan) {
    throw ApiError.badRequest(`Plan "${planId}" is not available`);
  }
  let sub = await subscriptionService.getForTenant(tenantId);
  if (!sub) {
    sub = await subscriptionService.createForTenant({
      tenantId,
      planId: plan.code,
      state: 'active',
      actor: actorOf(req),
      by: attribution(req),
      reason: 'Lazy provisioning on plan change',
    });
  } else {
    sub = await subscriptionService.changePlan({
      tenantId,
      planId: plan.code,
      actor: actorOf(req),
      by: attribution(req),
      reason: reason ?? null,
    });
  }
  return ApiResponse.ok(res, sub, 'Plan changed');
});

export const createCheckoutSession = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const { planId } = req.validated?.body ?? {};
  const result = await billingService.createCheckout({
    tenantId,
    planCode: planId,
    actor: actorOf(req),
    by: attribution(req),
  });
  return ApiResponse.ok(res, result, result.reused ? 'Checkout resumed' : 'Checkout created');
});

export const verifyCheckout = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } =
    req.validated?.body ?? {};
  const result = await billingService.verifyCheckout({
    tenantId,
    orderId,
    paymentId,
    signature,
    actor: actorOf(req),
    by: attribution(req),
  });
  return ApiResponse.ok(res, result, 'Payment verified');
});

export const listPurchasablePlans = asyncHandler(async (req, res) => {
  const { docs } = await planService.list({ page: 1, limit: 100 });
  const priced = billingPricing.listPricedPlans();
  const plans = docs
    .filter((p) => (p.data?.status ?? 'active') === 'active')
    .map((p) => ({
      code: p.code,
      name: p.name,
      displayName: p.data?.displayName ?? p.name,
      description: p.description ?? '',
      tier: p.data?.tier ?? 0,
      purchasable: billingPricing.isPurchasable(p.code),
      price: priced[p.code] ?? null,
    }))
    .sort((a, b) => a.tier - b.tier);
  return ApiResponse.ok(res, plans, 'Plans fetched');
});

export const reactivate = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const sub = await subscriptionService.reactivate({
    tenantId,
    actor: actorOf(req),
    by: attribution(req),
  });
  return ApiResponse.ok(res, sub, 'Subscription reactivated');
});

export default {
  getSubscription,
  getTimeline,
  cancelSubscription,
  changePlan,
  createCheckoutSession,
  verifyCheckout,
  listPurchasablePlans,
  reactivate,
};
