/**
 * Setting Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/settings`. Hot-reloadable, typed,
 *   scoped settings.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listSettings, getSetting, createSetting, updateSetting,
 *     deleteSetting, listTenantSettings
 *
 * CODING GUIDELINES
 *   - Resolve effective value across platform/tenant scopes.
 *   - `isSecret` settings return redacted values by default.
 *   - Writes emit invalidation events (handled by the service).
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

export const listSettings = notImplemented('GET /settings');
export const getSetting = notImplemented('GET /settings/:key');
export const createSetting = notImplemented('POST /settings');
export const updateSetting = notImplemented('PUT /settings/:key');
export const deleteSetting = notImplemented('DELETE /settings/:key');
export const listTenantSettings = notImplemented('GET /settings/tenants/:tenantId/settings');

export default {
  listSettings, getSetting, createSetting, updateSetting, deleteSetting,
  listTenantSettings,
};
