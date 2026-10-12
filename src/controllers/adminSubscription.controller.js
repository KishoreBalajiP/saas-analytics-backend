/**
 * Admin subscription controller (Phase 6 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for the platform-admin subscription surface.
 *   Mounted under `/admin/subscriptions`; every endpoint requires
 *   `adminAuth` plus a `billing.subscriptions.*` permission.
 *
 * RESPONSIBILITY
 *   - listSubscriptions, getSubscriptionForTenant
 *   - changePlan, setState
 *   - createCheckoutSession (provider adapter; 501 in Phase 6)
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import subscriptionService from '../services/subscription.service.js';
import planService from '../services/plan.service.js';
import { getProvider } from '../services/paymentProvider.adapter.js';
import { emit as auditEmit } from '../services/auditLog.service.js';

function actorOf(req) {
  return req.admin?.id ? { type: 'admin', id: req.admin.id } : { type: 'system', id: 'system' };
}

function ensureTenant(tenantId) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  return String(tenantId);
}

export const listSubscriptions = asyncHandler(async (req, res) => {
  const { page, limit, state, planId, search } = req.validated?.query ?? {};
  const filter = {};
  if (state) filter.state = state;
  if (planId) filter.planId = planId;
  const result = await subscriptionService.list({ page, limit, filter });
  return ApiResponse.ok(res, result.docs, 'Subscriptions fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

export const getSubscriptionForTenant = asyncHandler(async (req, res) => {
  const tenantId = ensureTenant(req.params.tenantId);
  const sub = await subscriptionService.getForTenant(tenantId);
  if (!sub) {
    return ApiResponse.ok(res, null, 'No subscription for this tenant');
  }
  await auditEmit({
    actor: actorOf(req),
    action: 'subscription.viewed',
    module: 'billing.subscriptions',
    resource: { type: 'tenant', id: tenantId },
    tenantId,
  });
  return ApiResponse.ok(res, sub, 'Subscription fetched');
});

export const adminChangePlan = asyncHandler(async (req, res) => {
  const tenantId = ensureTenant(req.params.tenantId);
  const { planId, reason } = req.validated?.body ?? {};
  const plan = await planService.getActiveByCode(planId);
  if (!plan) throw ApiError.badRequest(`Plan "${planId}" is not available`);
  let sub = await subscriptionService.getForTenant(tenantId);
  if (!sub) {
    sub = await subscriptionService.createForTenant({
      tenantId,
      planId: plan.code,
      state: 'active',
      actor: actorOf(req),
      by: req.admin?.id ?? null,
      reason: reason ?? 'Admin provisioning',
    });
  } else {
    sub = await subscriptionService.changePlan({
      tenantId,
      planId: plan.code,
      actor: actorOf(req),
      by: req.admin?.id ?? null,
      reason: reason ?? 'Admin change',
    });
  }
  return ApiResponse.ok(res, sub, 'Plan changed');
});

export const adminSetState = asyncHandler(async (req, res) => {
  const tenantId = ensureTenant(req.params.tenantId);
  const { state, reason, graceEndsAt } = req.validated?.body ?? {};
  const sub = await subscriptionService.setState({
    tenantId,
    state,
    graceEndsAt: graceEndsAt ?? null,
    actor: actorOf(req),
    by: req.admin?.id ?? null,
    reason,
  });
  return ApiResponse.ok(res, sub, 'Subscription state updated');
});

export const createCheckoutSession = asyncHandler(async (req, res) => {
  const tenantId = ensureTenant(req.params.tenantId);
  const provider = getProvider();
  if (!provider.isImplemented) {
    // Honest 501: the provider has not been selected yet.
    throw ApiError.notImplemented(
      'Checkout is not yet available. Use the admin plan-change endpoint to move the tenant to a new plan.',
    );
  }
  const { planId, successUrl, cancelUrl } = req.validated?.body ?? {};
  const session = await provider.createCheckoutSession({ tenantId, planId, successUrl, cancelUrl });
  return ApiResponse.ok(res, session, 'Checkout session created');
});

export const getTenantTimeline = asyncHandler(async (req, res) => {
  const tenantId = ensureTenant(req.params.tenantId);
  const { page, limit } = req.validated?.query ?? {};
  const result = await subscriptionService.listForTenant(tenantId, { page, limit });
  return ApiResponse.ok(res, result.docs, 'Timeline fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

export default {
  listSubscriptions,
  getSubscriptionForTenant,
  adminChangePlan,
  adminSetState,
  createCheckoutSession,
  getTenantTimeline,
};
