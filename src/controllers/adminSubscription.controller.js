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
import paymentTransactionRepository from '../repositories/paymentTransaction.repository.js';
import billingReconcileService from '../services/billingReconcile.service.js';
import WebhookEvent from '../models/WebhookEvent.js';
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

function sanitizeTransaction(txn) {
  if (!txn) return null;
  const { ...rest } = txn;
  return rest;
}

export const listTransactions = asyncHandler(async (req, res) => {
  const tenantId = ensureTenant(req.params.tenantId);
  const { page, limit } = req.validated?.query ?? {};
  const result = await paymentTransactionRepository.listForTenant(tenantId, {
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, (result.docs ?? []).map(sanitizeTransaction), 'Payment transactions fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

export const listWebhooks = asyncHandler(async (req, res) => {
  const tenantId = ensureTenant(req.params.tenantId);
  const { page = 1, limit = 20 } = req.validated?.query ?? {};
  const txnOrderIds = new Set(
    (await paymentTransactionRepository.listForTenant(tenantId, { page: 1, limit: 100 })).docs.map(
      (t) => t.providerOrderId,
    ),
  );
  const filter = { provider: 'razorpay' };
  const total = await WebhookEvent.countDocuments(filter);
  const docs = await WebhookEvent.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  // Only surface events correlated to this tenant's orders (plus
  // unknown-order events, which need operator triage).
  const related = docs.filter((d) => {
    const orderId = d?.raw?.orderId ?? null;
    if (!orderId) return true;
    return txnOrderIds.has(orderId);
  });
  const safe = related.map((d) => ({
    id: String(d._id),
    eventId: d.eventId,
    eventType: d.eventType,
    processed: d.processed,
    error: d.error ?? null,
    processedAt: d.processedAt ?? null,
    summary: d.raw ?? null,
    createdAt: d.createdAt,
  }));
  return ApiResponse.ok(res, safe.slice((page - 1) * limit, page * limit), 'Webhook events fetched', {
    page,
    limit,
    total: safe.length,
    pages: Math.ceil(safe.length / limit),
  });
});

export const triggerReconcile = asyncHandler(async (req, res) => {
  const { limit } = req.validated?.query ?? {};
  const result = await billingReconcileService.reconcilePending({
    limit: limit ?? 25,
    by: req.admin?.id ?? 'admin',
  });
  await auditEmit({
    actor: actorOf(req),
    action: 'billing.reconcile_triggered',
    module: 'billing.subscriptions',
    resource: { type: 'billing', id: 'reconcile' },
    after: result,
  });
  return ApiResponse.ok(res, result, 'Reconciliation complete');
});

export default {
  listSubscriptions,
  getSubscriptionForTenant,
  adminChangePlan,
  adminSetState,
  createCheckoutSession,
  getTenantTimeline,
  listTransactions,
  listWebhooks,
  triggerReconcile,
};
