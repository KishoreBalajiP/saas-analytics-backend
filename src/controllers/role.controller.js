/**
 * Role Controller (Sprint 2 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/roles`. Dynamic roles only - no
 *   hardcoded checks. Composition of permissions happens in
 *   `services/role.service.js`; this controller stays thin.
 *
 * RESPONSIBILITY
 *   - listRoles, createRole, getRole, updateRole, deleteRole
 *   - addPermissionToRole, removePermissionFromRole
 *
 * CODING GUIDELINES
 *   - Validate via `validators/role.validator.js`.
 *   - On delete, surface 409 if the role still has assignments; the
 *     service decides, the controller just maps to the HTTP code.
 *   - `by` attribution comes from the authenticated admin (never the body).
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import roleService from '../services/role.service.js';

const actor = (req) => req.admin?.id ?? null;

/** GET /roles - paginated list, filterable by tenant scope / search. */
export const listRoles = asyncHandler(async (req, res) => {
  const { tenantId, search, page, limit } = req.validated?.query ?? {};
  const result = await roleService.list({
    tenantId: tenantId ?? null,
    search,
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, result.docs, 'Roles fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** POST /roles - create a role in a scope (tenant or platform). */
export const createRole = asyncHandler(async (req, res) => {
  const { name, description, tenantId } = req.validated?.body ?? {};
  const role = await roleService.create({
    name,
    description,
    tenantId: tenantId ?? null,
    by: actor(req),
  });
  return ApiResponse.created(res, role, 'Role created');
});

/** GET /roles/:id - role plus its granted permission set. */
export const getRole = asyncHandler(async (req, res) => {
  const role = await roleService.getById({ id: req.params.id });
  const permissions = await roleService.listPermissions({ roleId: req.params.id });
  return ApiResponse.ok(res, { ...role, permissions }, 'Role fetched');
});

/** PATCH /roles/:id - rename / description. */
export const updateRole = asyncHandler(async (req, res) => {
  const role = await roleService.update({
    id: req.params.id,
    patch: req.validated?.body ?? {},
    by: actor(req),
  });
  return ApiResponse.ok(res, role, 'Role updated');
});

/** DELETE /roles/:id - delete (refuses system / in-use roles with 409). */
export const deleteRole = asyncHandler(async (req, res) => {
  const result = await roleService.remove({ id: req.params.id, by: actor(req) });
  return ApiResponse.ok(res, result, 'Role deleted');
});

/** POST /roles/:id/permissions - grant a permission to the role. */
export const addPermissionToRole = asyncHandler(async (req, res) => {
  const { permissionKey } = req.validated?.body ?? {};
  const result = await roleService.addPermission({
    roleId: req.params.id,
    permissionKey,
    by: actor(req),
  });
  return ApiResponse.created(res, result, result.alreadyGranted ? 'Permission already granted' : 'Permission granted');
});

/** DELETE /roles/:id/permissions - revoke a permission from the role. */
export const removePermissionFromRole = asyncHandler(async (req, res) => {
  const { permissionKey } = req.validated?.body ?? {};
  const result = await roleService.removePermission({
    roleId: req.params.id,
    permissionKey,
    by: actor(req),
  });
  return ApiResponse.ok(res, result, 'Permission revoked');
});

export default {
  listRoles, createRole, getRole, updateRole, deleteRole,
  addPermissionToRole, removePermissionFromRole,
};
