/**
 * Dashboard Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/dashboards`. Versioned, tenant-scoped,
 *   shareable interactive views.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listDashboards, createDashboard, getDashboard, updateDashboard,
 *     publishDashboard, shareDashboard, revokeShare, deleteDashboard
 *
 * CODING GUIDELINES
 *   - Tenant isolation via `tenantIsolation.middleware.js`.
 *   - Shares flow through `iam/permissions/`. No bespoke ACL tables.
 *   - `/getDashboard` accepts `?version=` for historical versions.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

export const listDashboards = notImplemented('GET /dashboards');
export const createDashboard = notImplemented('POST /dashboards');
export const getDashboard = notImplemented('GET /dashboards/:id');
export const updateDashboard = notImplemented('PATCH /dashboards/:id');
export const publishDashboard = notImplemented('POST /dashboards/:id/publish');
export const shareDashboard = notImplemented('POST /dashboards/:id/share');
export const revokeShare = notImplemented('DELETE /dashboards/:id/share/:entryId');
export const deleteDashboard = notImplemented('DELETE /dashboards/:id');

export default {
  listDashboards, createDashboard, getDashboard, updateDashboard,
  publishDashboard, shareDashboard, revokeShare, deleteDashboard,
};
