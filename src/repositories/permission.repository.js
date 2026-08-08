/**
 * Permission Repository (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for the dynamic RBAC primitives: modules,
 *   actions, permissions, and the actor-permission resolution.
 *
 * RESPONSIBILITY
 *   - listModules, createModule, findModuleByKey
 *   - listActions, registerAction
 *   - listPermissions, createPermission, bulkCreatePermissions,
 *     deletePermission, findPermissionByKey, findPermissionById
 *   - resolvePermissionsForActor({ actorType, actorId, tenantId })
 *     -> Set<`module.action`> used by permission.middleware.js
 *
 * CODING GUIDELINES
 *   - Lean returns; `resolvePermissionsForActor` returns a Set, callers
 *     serialise to arrays before caching.
 *   - Permission key MUST be `${moduleKey}.${action}`. Enforced here and
 *     at the validator layer.
 *   - `resolvePermissionsForActor` is the hot path; the service caches it.
 *
 * FUTURE EXTENSION
 *   - Phase 3 backs the resolver with a Mongo aggregation + cache projection.
 */

import { Module } from '../models/Module.js';
import { Permission } from '../models/Permission.js';
import { RolePermission } from '../models/RolePermission.js';
import { UserRole } from '../models/UserRole.js';
import { AdminRole } from '../models/AdminRole.js';

/** Paginated module list. */
export const listModules = async ({ filter = {}, page = 1, limit = 20 } = {}) => {
  const result = await Module.paginate(filter, {
    page,
    limit,
    lean: true,
    sort: { createdAt: 1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Create a module. Returns the saved plain document. */
export const createModule = async (data) => {
  const doc = new Module(data);
  await doc.save();
  return doc.toObject();
};

/** Find a module by its (dotted) key. */
export const findModuleByKey = (key) => Module.findOne({ key: key.toLowerCase() }).lean();

/**
 * Distinct actions currently registered on a module (derived from its
 * permissions). The canonical action catalogue is defined in the model.
 */
export const listActions = async (moduleKey) => {
  const rows = await Permission.distinct('action', { module: moduleKey.toLowerCase() });
  return rows.sort();
};

/**
 * Register a `module.action` permission. Idempotent: returns the existing
 * row (or `null` when it already exists) without throwing.
 */
export const registerAction = async ({ moduleId, module, action, description = '', isSystem = false, createdBy = null }) => {
  const key = `${module.toLowerCase()}.${action.toLowerCase()}`;
  try {
    const doc = new Permission({
      moduleId,
      module: module.toLowerCase(),
      action: action.toLowerCase(),
      key,
      description,
      isSystem,
      createdBy,
    });
    await doc.save();
    return doc.toObject();
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
};

/** Paginated permission list, filterable by module and/or action. */
export const listPermissions = async ({ module, action, filter = {}, page = 1, limit = 20 } = {}) => {
  const query = { ...filter };
  if (module) query.module = module.toLowerCase();
  if (action) query.action = action.toLowerCase();
  const result = await Permission.paginate(query, {
    page,
    limit,
    lean: true,
    sort: { module: 1, action: 1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Find a permission by its composed key (`module.action`). */
export const findPermissionByKey = (key) => Permission.findOne({ key: key.toLowerCase() }).lean();

/** Find a permission by id. Returns a lean object or null. */
export const findPermissionById = (id) => Permission.findById(id).lean();

/** Create a permission directly (callers MUST supply a valid `moduleId`). */
export const createPermission = async (data) => {
  const doc = new Permission(data);
  await doc.save();
  return doc.toObject();
};

/**
 * Bulk-create permissions, skipping keys that already exist. Returns the
 * number of newly created rows.
 */
export const bulkCreatePermissions = async (items) => {
  const existing = await Permission.find({
    key: { $in: items.map((i) => i.key) },
  })
    .select('key')
    .lean();
  const seen = new Set(existing.map((p) => p.key));
  const fresh = items.filter((i) => !seen.has(i.key));
  if (fresh.length === 0) return 0;
  const inserted = await Permission.insertMany(fresh, { ordered: false });
  return inserted.length;
};

/** Soft-delete a permission. Returns the plain doc or null. */
export const deletePermission = async (id, by) => {
  const doc = await Permission.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/**
 * Resolve the effective permission-key set for an actor. This is the
 * hot-path RBAC read:
 *
 *   actor (AdminRole | UserRole) -> roleIds -> RolePermission -> Permission.key
 *
 * Admins resolve their platform grants (`tenantId === null`) when no
 * tenant scope is supplied, or their grants scoped to a specific support
 * tenant when one is.
 *
 * @param {{ actorType: 'admin'|'user', actorId: string, tenantId?: string|null }} actor
 * @returns {Promise<Set<string>>}
 */
export const resolvePermissionsForActor = async ({ actorType, actorId, tenantId = null }) => {
  const roleIds = actorType === 'admin'
    ? (await AdminRole.find({ adminId: actorId, tenantId }).select('roleId').lean()).map((r) => r.roleId)
    : (await UserRole.find({ tenantId, userId: actorId }).select('roleId').lean()).map((r) => r.roleId);

  if (roleIds.length === 0) return new Set();

  const joins = await RolePermission.find({ roleId: { $in: roleIds } })
    .select('permissionId')
    .lean();
  if (joins.length === 0) return new Set();

  const permissionIds = [...new Set(joins.map((j) => j.permissionId))];
  const perms = await Permission.find({ _id: { $in: permissionIds } }).select('key').lean();
  return new Set(perms.map((p) => p.key));
};

export default {
  listModules,
  createModule,
  findModuleByKey,
  listActions,
  registerAction,
  listPermissions,
  createPermission,
  bulkCreatePermissions,
  deletePermission,
  findPermissionByKey,
  findPermissionById,
  resolvePermissionsForActor,
  _meta: { hotPath: ['resolvePermissionsForActor'] },
};
