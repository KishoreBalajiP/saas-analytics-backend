/**
 * Admin plan controller (Phase 6 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for the platform-admin plan catalogue surface.
 *   Mounted under `/admin/plans`; every endpoint requires
 *   `adminAuth` plus a `billing.plans.*` permission.
 *
 * RESPONSIBILITY
 *   - listPlans, getPlan
 *   - createPlan, updatePlan
 *   - archivePlan, disablePlan, enablePlan
 *   - ensureDefaults (admin-triggered seed)
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import planService from '../services/plan.service.js';
import { emit as auditEmit } from '../services/auditLog.service.js';

function actorOf(req) {
  return req.admin?.id ? { type: 'admin', id: req.admin.id } : { type: 'system', id: 'system' };
}

export const listPlans = asyncHandler(async (req, res) => {
  const { page, limit, search } = req.validated?.query ?? {};
  const result = await planService.list({ page, limit, search });
  return ApiResponse.ok(res, result.docs, 'Plans fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

export const getPlan = asyncHandler(async (req, res) => {
  const plan = await planService.getById(req.params.id);
  return ApiResponse.ok(res, plan, 'Plan fetched');
});

export const createPlan = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const plan = await planService.create({ ...body }, req.admin?.id ?? null);
  await auditEmit({
    actor: actorOf(req),
    action: 'plan.created',
    module: 'billing.plans',
    resource: { type: 'plan', id: plan.id },
    after: { code: plan.code, name: plan.name, data: plan.data },
  });
  return ApiResponse.created(res, plan, 'Plan created');
});

export const updatePlan = asyncHandler(async (req, res) => {
  const patch = req.validated?.body ?? {};
  const plan = await planService.update(req.params.id, patch, req.admin?.id ?? null);
  await auditEmit({
    actor: actorOf(req),
    action: 'plan.updated',
    module: 'billing.plans',
    resource: { type: 'plan', id: plan.id },
    after: { code: plan.code, data: plan.data },
  });
  return ApiResponse.ok(res, plan, 'Plan updated');
});

export const archivePlan = asyncHandler(async (req, res) => {
  const plan = await planService.archive(req.params.id, req.admin?.id ?? null);
  await auditEmit({
    actor: actorOf(req),
    action: 'plan.archived',
    module: 'billing.plans',
    resource: { type: 'plan', id: plan.id },
  });
  return ApiResponse.ok(res, plan, 'Plan archived');
});

export const disablePlan = asyncHandler(async (req, res) => {
  const plan = await planService.disable(req.params.id, req.admin?.id ?? null);
  await auditEmit({
    actor: actorOf(req),
    action: 'plan.disabled',
    module: 'billing.plans',
    resource: { type: 'plan', id: plan.id },
  });
  return ApiResponse.ok(res, plan, 'Plan disabled');
});

export const enablePlan = asyncHandler(async (req, res) => {
  const plan = await planService.enable(req.params.id, req.admin?.id ?? null);
  await auditEmit({
    actor: actorOf(req),
    action: 'plan.enabled',
    module: 'billing.plans',
    resource: { type: 'plan', id: plan.id },
  });
  return ApiResponse.ok(res, plan, 'Plan enabled');
});

export const ensureDefaults = asyncHandler(async (req, res) => {
  const result = await planService.ensureDefaults(req.admin?.id ?? null);
  return ApiResponse.ok(res, result, 'Default plans ensured');
});

export default {
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  archivePlan,
  disablePlan,
  enablePlan,
  ensureDefaults,
};
