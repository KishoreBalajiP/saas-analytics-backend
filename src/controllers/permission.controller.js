/**
 * Permission Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/permissions`. Manages the dynamic
 *   RBAC primitives: modules, actions, permissions.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listModules, createModule, getModuleActions
 *   - listPermissions, createPermission, bulkCreatePermissions
 *   - deletePermission (only if no role assignments)
 *
 * CODING GUIDELINES
 *   - Permission key MUST be `<module_key>.<action>`. Enforced in
 *     `validators/permission.validator.js`.
 *   - Registering a new module invalidates the rbac cache for every
 *     scope; the service handles fan-out, this controller just returns
 *     the count.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

export const listModules = notImplemented('GET /permissions/modules');
export const createModule = notImplemented('POST /permissions/modules');
export const getModuleActions = notImplemented('GET /permissions/modules/:key/actions');
export const listPermissions = notImplemented('GET /permissions');
export const createPermission = notImplemented('POST /permissions');
export const bulkCreatePermissions = notImplemented('POST /permissions/bulk');
export const deletePermission = notImplemented('DELETE /permissions/:id');

export default {
  listModules, createModule, getModuleActions,
  listPermissions, createPermission, bulkCreatePermissions, deletePermission,
};
