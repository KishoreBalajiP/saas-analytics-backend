/**
 * Workspace Settings Controller.
 *
 * HTTP layer for `/api/v1/workspace/settings` (tenant self-service).
 * Reads the tenant from the resolved request context, never from the body.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import workspaceSettingsService from '../services/workspaceSettings.service.js';

const actorOf = (req) => req.user?.id ?? null;

/** GET /api/v1/workspace/settings */
export const getSettings = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  const settings = await workspaceSettingsService.get({ tenantId });
  return ApiResponse.ok(res, settings, 'Workspace settings');
});

/** PATCH /api/v1/workspace/settings */
export const updateSettings = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  // The raw body is checked strictly by the service (unknown keys -> 400).
  const settings = await workspaceSettingsService.update({ tenantId, actorId: actorOf(req), patch: req.body ?? {} });
  return ApiResponse.ok(res, settings, 'Workspace settings updated');
});

export default { getSettings, updateSettings };
