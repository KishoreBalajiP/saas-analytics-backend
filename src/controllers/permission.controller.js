/**
 * Permission Controller (Sprint 2 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/permissions`. Manages the dynamic RBAC
 *   primitives: modules, actions, permissions.
 *
 * RESPONSIBILITY
 *   - listModules, createModule, getModuleActions
 *   - listPermissions, createPermission, bulkCreatePermissions
 *   - deletePermission
 *
 * CODING GUIDELINES
 *   - Permission keys MUST be `<module_key>.<action>`; enforced in
 *     `validators/permission.validator.js` and the service.
 *   - Deleting a permission is key-based (the service resolves it), so the
 *     route is `DELETE /permissions` with a body `{ permissionKey }`.
 *   - `by` attribution comes from the authenticated admin (never the body).
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import permissionService from '../services/permission.service.js';

const actor = (req) => req.admin?.id ?? null;

/** GET /permissions/modules - paginated module registry. */
export const listModules = asyncHandler(async (req, res) => {
  const { search, page, limit } = req.validated?.query ?? {};
  const result = await permissionService.listModules({
    search,
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, result.docs, 'Modules fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** POST /permissions/modules - register a module (dotted keys allowed). */
export const createModule = asyncHandler(async (req, res) => {
  const { key, name, description } = req.validated?.body ?? {};
  const module = await permissionService.createModule({
    key,
    name,
    description,
    by: actor(req),
  });
  return ApiResponse.created(res, module, 'Module registered');
});

/** GET /permissions/modules/:key/actions - actions registered on a module. */
export const getModuleActions = asyncHandler(async (req, res) => {
  const actions = await permissionService.getModuleActions({ moduleKey: req.params.key });
  return ApiResponse.ok(res, actions, 'Module actions fetched');
});

/** GET /permissions - paginated permission list, filterable by module/action. */
export const listPermissions = asyncHandler(async (req, res) => {
  const { module, action, page, limit } = req.validated?.query ?? {};
  const result = await permissionService.listPermissions({
    module,
    action,
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, result.docs, 'Permissions fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** POST /permissions - register a single (module, action) permission. */
export const createPermission = asyncHandler(async (req, res) => {
  const { module, action, description } = req.validated?.body ?? {};
  const permission = await permissionService.createPermission({
    module,
    action,
    description,
    by: actor(req),
  });
  return ApiResponse.created(res, permission, 'Permission created');
});

/** POST /permissions/bulk - bulk-register permissions (idempotent). */
export const bulkCreatePermissions = asyncHandler(async (req, res) => {
  const { items } = req.validated?.body ?? {};
  const result = await permissionService.bulkCreatePermissions({
    items,
    by: actor(req),
  });
  return ApiResponse.created(res, result, 'Permissions processed');
});

/** DELETE /permissions - soft-delete a permission by its key. */
export const deletePermission = asyncHandler(async (req, res) => {
  const { permissionKey } = req.validated?.body ?? {};
  const result = await permissionService.deletePermission({
    key: permissionKey,
    by: actor(req),
  });
  return ApiResponse.ok(res, result, 'Permission deleted');
});

export default {
  listModules, createModule, getModuleActions,
  listPermissions, createPermission, bulkCreatePermissions, deletePermission,
};
