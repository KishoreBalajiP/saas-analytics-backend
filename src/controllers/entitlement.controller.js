/**
 * Entitlement controller (Phase 6 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for the workspace-facing entitlement surface.
 *   Resolves the canonical entitlement and the current usage map.
 *   The controller never reaches into the entitlement service for
 *   a write — writes go through the canonical write services
 *   (subscription / usage / connector / dashboard / ...).
 *
 * RESPONSIBILITY
 *   - getEntitlements     GET /tenants/:id/entitlements
 *   - getUsage            GET /tenants/:id/usage
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import entitlementService from '../services/entitlement.service.js';

function resolveTenantId(req) {
  const fromParam = req.params?.id ?? null;
  if (fromParam) return String(fromParam);
  return req.tenant?.id ?? req.user?.tenantId ?? req.admin?.tenantId ?? null;
}

export const getEntitlements = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const ent = await entitlementService.resolveEffective(tenantId);
  return ApiResponse.ok(res, ent, 'Entitlements fetched');
});

export const getUsage = asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  // `?period=YYYY-MM-DD` reads metered metrics (API calls) for that UTC day.
  const at = entitlementService.parseUsagePeriod(req.query?.period);
  const usage = await entitlementService.getUsage(tenantId, at ? { now: at } : {});
  return ApiResponse.ok(res, usage, 'Usage fetched');
});

export default {
  getEntitlements,
  getUsage,
};
