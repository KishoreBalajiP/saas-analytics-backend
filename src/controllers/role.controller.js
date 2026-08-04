/**
 * Role Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/roles`. Dynamic roles only - no
 *   hardcoded checks. Composition of permissions happens in
 *   `services/role.service.js`; this controller stays thin.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listRoles, createRole, getRole, updateRole, deleteRole
 *   - addPermissionToRole, removePermissionFromRole
 *
 * CODING GUIDELINES
 *   - Validate via `validators/role.validator.js`.
 *   - On delete, surface 409 if the role still has assignments; the
 *     service decides, the controller just maps to the HTTP code.
 *   - Return lean role objects; permissions come via `getRole(id)`
 *     which expands them in the service layer.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

export const listRoles = notImplemented('GET /roles');
export const createRole = notImplemented('POST /roles');
export const getRole = notImplemented('GET /roles/:id');
export const updateRole = notImplemented('PATCH /roles/:id');
export const deleteRole = notImplemented('DELETE /roles/:id');
export const addPermissionToRole = notImplemented('POST /roles/:id/permissions');
export const removePermissionFromRole = notImplemented('DELETE /roles/:id/permissions/:permId');

export default {
  listRoles, createRole, getRole, updateRole, deleteRole,
  addPermissionToRole, removePermissionFromRole,
};
