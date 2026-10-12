/**
 * Admin entitlement controller (Phase 6 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for the platform-admin entitlement surface
 *   (overrides + usage inspection). Mounted under
 *   `/admin/entitlements` and `/admin/usage`; every endpoint
 *   requires `adminAuth` plus a `billing.entitlements.*` permission.
 *
 * RESPONSIBILITY
 *   - listAllOverrides, listTenantOverrides
 *   - createOverride, revokeOverride
 *   - getTenantUsage, getTenantEntitlements
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import entitlementOverrideService from '../services/entitlementOverride.service.js';
import entitlementService from '../services/entitlement.service.js';

function ensureTenant(tenantId) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  return String(tenantId);
}

export const listAllOverrides = asyncHandler(async (req, res) => {
  const { page, limit, includeRevoked } = req.validated?.query ?? {};
  const result = await entitlementOverrideService.listAll({
    page,
    limit,
    includeRevoked: includeRevoked !== false,
  });
  return ApiResponse.ok(res, result.docs, 'Overrides fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

export const listTenantOverrides = asyncHandler(async (req, res) => {
  const tenantId = ensureTenant(req.params.tenantId);
  const { page, limit, includeRevoked } = req.validated?.query ?? {};
  const result = await entitlementOverrideService.list({
    tenantId,
    page,
    limit,
    includeRevoked: includeRevoked === true,
  });
  return ApiResponse.ok(res, result.docs, 'Overrides fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

export const createOverride = asyncHandler(async (req, res) => {
  const tenantId = ensureTenant(req.params.tenantId);
  const body = req.validated?.body ?? {};
  const override = await entitlementOverrideService.create({
    tenantId,
    metric: body.metric ?? null,
    kind: body.kind,
    value: body.value,
    reason: body.reason,
    expiresAt: body.expiresAt ?? null,
    by: req.admin?.id ?? 'system',
  });
  return ApiResponse.created(res, override, 'Override created');
});

export const revokeOverride = asyncHandler(async (req, res) => {
  const id = req.params?.id;
  if (!id) throw ApiError.badRequest('id is required');
  const { reason } = req.validated?.body ?? {};
  const override = await entitlementOverrideService.revoke(id, {
    by: req.admin?.id ?? 'system',
    reason,
  });
  return ApiResponse.ok(res, override, 'Override revoked');
});

export const getTenantEntitlements = asyncHandler(async (req, res) => {
  const tenantId = ensureTenant(req.params.tenantId);
  const ent = await entitlementService.resolveEffective(tenantId);
  return ApiResponse.ok(res, ent, 'Entitlements fetched');
});

export const getTenantUsage = asyncHandler(async (req, res) => {
  const tenantId = ensureTenant(req.params.tenantId);
  const usage = await entitlementService.getUsage(tenantId);
  return ApiResponse.ok(res, usage, 'Usage fetched');
});

export default {
  listAllOverrides,
  listTenantOverrides,
  createOverride,
  revokeOverride,
  getTenantEntitlements,
  getTenantUsage,
};
