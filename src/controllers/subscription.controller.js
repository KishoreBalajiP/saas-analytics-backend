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
 *   - changePlan (billing: a downgrade is queued for the period end)
 *   - reactivate
 *   - createCheckoutSession, verifyCheckout, getCheckoutStatus
 *   - listTransactions (billing history), listPurchasablePlans
 *
 * BILLING (roadmap 3.1)
 *   Workspace routes never write `planId`: a missing subscription is
 *   provisioned on the server-side default (free, or the tenant record's
 *   trial), paid plans only arrive through a provider-confirmed checkout,
 *   and a downgrade is queued for the end of the paid term.
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
import config from '../config/env.js';
import subscriptionService from '../services/subscription.service.js';
import planService from '../services/plan.service.js';
import billingService from '../services/billing.service.js';
import billingPricing from '../services/billingPricing.service.js';
import { getProvider } from '../services/paymentProvider.adapter.js';

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

/** billing: the stored subscription plus its computed access right now. */
async function withAccess(sub) {
  if (!sub) return sub;
  const { plan } = await planService.resolveByCode(sub.planId);
  const access = subscriptionService.computeAccess(sub, { graceDays: subscriptionService.graceDaysFor(plan) });
  return {
    ...sub,
    access: {
      state: access.state,
      planId: access.planId,
      writeBlocked: access.writeBlocked,
      inGrace: access.inGrace,
      graceEndsAt: access.graceEndsAt ? access.graceEndsAt.toISOString() : null,
      periodEnded: access.periodEnded,
      reason: access.reason,
    },
  };
}

/** Lazy provisioning on the server-side default (never a request plan). */
function ensure(req, tenantId, reason) {
  return subscriptionService.ensureForTenant({ tenantId, actor: actorOf(req), by: attribution(req), reason });
}

export const getSubscription = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const sub = await ensure(req, tenantId, 'Lazy provisioning on first read');
  return ApiResponse.ok(res, await withAccess(sub), 'Subscription fetched');
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
  await ensure(req, tenantId, 'Lazy provisioning on first mutation');
  const sub = await subscriptionService.cancel({
    tenantId,
    actor: actorOf(req),
    by: attribution(req),
    immediate: immediate === true,
    reason: reason ?? null,
  });
  return ApiResponse.ok(res, await withAccess(sub), 'Subscription canceled');
});

export const changePlan = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const { planId, reason } = req.validated?.body ?? {};
  const plan = await planService.getActiveByCode(planId);
  if (!plan) {
    throw ApiError.badRequest(`Plan "${planId}" is not available`);
  }
  const current = await ensure(req, tenantId, 'Lazy provisioning on plan change');
  await billingService.reconcileBeforePlanSwitch({
    tenantId,
    targetPlanCode: plan.code,
    actor: actorOf(req),
    by: attribution(req),
  });
  // Workspace users may only move to the free plan (or withdraw a queued
  // move by choosing their current plan). Any paid plan must go through a
  // provider-confirmed checkout; writing it here would grant it unpaid.
  if (!planService.isFreePlan(plan) && plan.code !== current.planId) {
    throw ApiError.forbidden('Changing to a paid plan requires payment. Start a checkout for this plan instead.');
  }
  const sub = await subscriptionService.scheduleChange({
    tenantId,
    planId: plan.code,
    actor: actorOf(req),
    by: attribution(req),
    reason: reason ?? null,
    source: 'workspace',
  });
  const queued = Boolean(sub.scheduledChange);
  return ApiResponse.ok(res, await withAccess(sub), queued ? 'Plan change scheduled for the end of the term' : 'Plan changed');
});

export const createCheckoutSession = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const { planId, interval } = req.validated?.body ?? {};
  const result = await billingService.createCheckout({
    tenantId,
    planCode: planId,
    interval: interval ?? 'month',
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
  return ApiResponse.ok(
    res,
    result,
    result.phase === 'confirmed' ? 'Payment confirmed' : 'Payment received; waiting for provider confirmation',
  );
});

export const getCheckoutStatus = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const result = await billingService.getCheckoutStatus({ tenantId, orderId: req.validated?.params?.orderId });
  return ApiResponse.ok(res, result, 'Checkout status fetched');
});

export const cancelCheckout = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const result = await billingService.cancelCheckout({
    tenantId,
    orderId: req.validated?.params?.orderId,
    actor: actorOf(req),
    by: attribution(req),
  });
  return ApiResponse.ok(res, result, 'Checkout abandoned');
});

export const listTransactions = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const { page, limit } = req.validated?.query ?? {};
  const result = await billingService.listTransactionsForTenant(tenantId, { page: page ?? 1, limit: limit ?? 20 });
  return ApiResponse.ok(res, result.docs, 'Billing history fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** billing: what the checkout UI may say about the provider (no secrets). */
function checkoutConfig() {
  const provider = getProvider('razorpay');
  const enabled = provider?.isImplemented === true;
  return {
    enabled,
    provider: enabled ? provider.name : null,
    environment: enabled ? (provider.environment ?? config?.razorpay?.environment ?? null) : null,
    model: 'prepaid_terms',
    intervals: billingPricing.SUPPORTED_INTERVALS,
  };
}

export const listPurchasablePlans = asyncHandler(async (req, res) => {
  const { docs } = await planService.list({ page: 1, limit: 100 });
  const checkout = checkoutConfig();
  const plans = docs
    .filter((p) => (p.data?.status ?? 'active') === 'active')
    .map((row) => {
      const plan = { code: row.code, data: { ...(row.data ?? {}) } };
      const prices = billingPricing.listPlanPrices(plan);
      return {
        code: row.code,
        name: row.name,
        displayName: row.data?.displayName ?? row.name,
        description: row.data?.description ?? row.description ?? '',
        tier: row.data?.tier ?? 0,
        trialDays: row.data?.trialDays ?? 0,
        features: row.data?.features ?? {},
        limits: row.data?.limits ?? {},
        prices,
        purchasable: checkout.enabled && !planService.isFreePlan(row.code) && prices.length > 0,
      };
    })
    .sort((a, b) => a.tier - b.tier);
  return ApiResponse.ok(res, { plans, checkout }, 'Plans fetched');
});

export const reactivate = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  // Self-service reactivation only undoes the workspace's own cancellation
  // while the paid term runs. Restricted, expired and past-due
  // subscriptions need a payment or a platform admin.
  const current = await subscriptionService.getForTenant(tenantId);
  if (current && current.state !== 'canceled' && current.state !== 'active') {
    throw ApiError.forbidden(`A ${current.state} subscription cannot be reactivated from the workspace. Complete a payment or contact support.`);
  }
  const sub = await subscriptionService.reactivate({
    tenantId,
    actor: actorOf(req),
    by: attribution(req),
  });
  return ApiResponse.ok(res, await withAccess(sub), 'Subscription reactivated');
});

export default {
  getSubscription,
  getTimeline,
  cancelSubscription,
  changePlan,
  createCheckoutSession,
  verifyCheckout,
  getCheckoutStatus,
  cancelCheckout,
  listTransactions,
  listPurchasablePlans,
  reactivate,
};
