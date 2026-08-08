/**
 * Role Service (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Business logic for dynamic role management. Composes roles from
 *   permissions, guards system roles and live assignments, and keeps the
 *   RBAC cache coherent after every mutation.
 *
 * RESPONSIBILITY
 *   - list({ tenantId, page, limit })        -> paginated roles in a scope
 *   - create({ tenantId, name, ... })        -> scoped role creation
 *   - getById({ id })
 *   - update({ id, patch, by })
 *   - remove({ id, by })                     -> refuses system/in-use roles
 *   - addPermission / removePermission       -> RolePermission membership
 *
 * CODING GUIDELINES
 *   - `tenantId === null` is the platform scope; a non-null value is a
 *     tenant scope. `level` is derived from `tenantId` and validated by
 *     the model's pre-validate hook.
 *   - `isSystem` roles are immutable: update and remove throw 409.
 *   - Remove refuses while `countAssignments(roleId) > 0` (409).
 *   - Every mutation invalidates the RBAC cache for the affected scope.
 *   - All expected failures use `ApiError` factories.
 */

import ApiError from '../utils/ApiError.js';
import roleRepository from '../repositories/role.repository.js';
import permissionRepository from '../repositories/permission.repository.js';
import { invalidateScope, resolve } from './rbac.cache.service.js';

/** Fields a caller may patch on a role. `scope`/`level`/`isSystem` are excluded. */
const UPDATABLE = ['name', 'description'];

/**
 * List roles in a scope (tenant or platform).
 *
 * @param {Object} opts
 * @param {string|null} [opts.tenantId=null] - null lists platform roles.
 * @param {string} [opts.search] - optional name-substring filter.
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {Promise<{ docs: Object[], total: number, page: number, limit: number, pages: number }>}
 */
export async function list({ tenantId = null, search, page = 1, limit = 20 } = {}) {
  const filter = {};
  if (search) filter.name = { $regex: escapeRegExp(search), $options: 'i' };
  return roleRepository.list({ tenantId, filter, page, limit });
}

/**
 * Create a role in a scope. Rejects a duplicate name with 409.
 *
 * @param {Object} opts
 * @param {string} opts.name
 * @param {string|null} [opts.tenantId=null]
 * @param {string} [opts.description='']
 * @param {string|null} [opts.by=null] - actor id for audit attribution.
 * @returns {Promise<Object>} saved role (plain).
 */
export async function create({ name, tenantId = null, description = '', by = null } = {}) {
  const normalized = String(name ?? '').trim();
  if (!normalized) throw ApiError.badRequest('Role name is required');
  const existing = await roleRepository.findByName({ tenantId, name: normalized });
  if (existing) throw ApiError.conflict(`A role named "${normalized}" already exists in this scope`);
  const role = await roleRepository.create({
    tenantId,
    name: normalized,
    description,
    level: tenantId == null ? 'platform' : 'tenant',
    isSystem: false,
    createdBy: by,
  });
  await invalidateScope(tenantId);
  return role;
}

/**
 * Get a single role by id.
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @returns {Promise<Object>}
 */
export async function getById({ id } = {}) {
  const role = await roleRepository.findById(id);
  if (!role) throw ApiError.notFound('Role not found');
  return role;
}

/**
 * Update a role's mutable fields. System roles are immutable (409).
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @param {Object} [opts.patch={}]
 * @param {string|null} [opts.by=null]
 * @returns {Promise<Object>} updated role (plain).
 */
export async function update({ id, patch = {}, by = null } = {}) {
  const role = await roleRepository.findById(id);
  if (!role) throw ApiError.notFound('Role not found');
  if (role.isSystem) throw ApiError.conflict('System roles cannot be modified');

  const set = {};
  for (const key of UPDATABLE) {
    if (patch[key] !== undefined) set[key] = patch[key];
  }
  if (Object.keys(set).length === 0) throw ApiError.badRequest('Nothing to update');
  set.updatedBy = by;

  const updated = await roleRepository.update(id, set);
  await invalidateScope(role.tenantId ?? null);
  return updated;
}

/**
 * Soft-delete a role and clear its permission membership. Refuses system
 * roles and any role with live user/admin assignments (409).
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @param {string|null} [opts.by=null]
 * @returns {Promise<{ ok: true }>}
 */
export async function remove({ id, by = null } = {}) {
  const role = await roleRepository.findById(id);
  if (!role) throw ApiError.notFound('Role not found');
  if (role.isSystem) throw ApiError.conflict('System roles cannot be deleted');

  const assignments = await roleRepository.countAssignments(id);
  if (assignments > 0) {
    throw ApiError.conflict(`Role is assigned to ${assignments} account(s); revoke them before deleting`);
  }

  await roleRepository.softDelete(id, by);
  await roleRepository.clearPermissions(id);
  await invalidateScope(role.tenantId ?? null);
  return { ok: true };
}

/**
 * Grant a permission to a role. Idempotent: re-attaching an existing
 * membership is a no-op success.
 *
 * @param {Object} opts
 * @param {string} opts.roleId
 * @param {string} opts.permissionKey - `<module>.<action>`.
 * @param {string|null} [opts.by=null]
 * @returns {Promise<Object>} the join row, or `{ alreadyGranted: true }`.
 */
export async function addPermission({ roleId, permissionKey, by = null } = {}) {
  const role = await roleRepository.findById(roleId);
  if (!role) throw ApiError.notFound('Role not found');
  const permission = await permissionRepository.findPermissionByKey(permissionKey);
  if (!permission) throw ApiError.notFound(`Permission "${permissionKey}" not found`);

  const joined = await roleRepository.attachPermission(roleId, permission._id, by);
  await invalidateScope(role.tenantId ?? null);
  if (!joined) return { alreadyGranted: true };
  return joined;
}

/**
 * Revoke a permission from a role. Idempotent: a missing membership is a
 * no-op success.
 *
 * @param {Object} opts
 * @param {string} opts.roleId
 * @param {string} opts.permissionKey - `<module>.<action>`.
 * @param {string|null} [opts.by=null]
 * @returns {Promise<{ removed: number }>}
 */
export async function removePermission({ roleId, permissionKey, by = null } = {}) {
  const role = await roleRepository.findById(roleId);
  if (!role) throw ApiError.notFound('Role not found');
  const permission = await permissionRepository.findPermissionByKey(permissionKey);
  if (!permission) throw ApiError.notFound(`Permission "${permissionKey}" not found`);

  const removed = await roleRepository.detachPermission(roleId, permission._id);
  await invalidateScope(role.tenantId ?? null);
  return { removed };
}

/**
 * Resolve the role NAMES an actor currently holds. Cached per actor for 60s
 * under the same versioned RBAC scheme as permissions (different `kind`, so
 * the two sets never collide); cache failure degrades to the live query.
 *
 * @param {Object} opts
 * @param {'admin'|'user'} opts.actorType
 * @param {string} opts.actorId
 * @param {string|null} [opts.tenantId=null] - user actors require a tenant.
 * @returns {Promise<string[]>} sorted role names.
 */
export async function resolveActorRoles({ actorType, actorId, tenantId = null } = {}) {
  if (!actorType || !actorId) throw ApiError.badRequest('actorType and actorId are required');
  if (actorType === 'user' && !tenantId) throw ApiError.badRequest('tenantId is required for user actors');

  const live = async () => {
    const set = await roleRepository.resolveRolesForActor({ actorType, actorId, tenantId });
    return [...set].sort();
  };
  return resolve({ kind: 'roles', tenantId, actorType, actorId, fn: live });
}

/**
 * List the permissions currently granted to a role (expanded via the
 * `RolePermission` join rows).
 *
 * @param {Object} opts
 * @param {string} opts.roleId
 * @returns {Promise<Object[]>} permission docs (plain), ordered by join time.
 */
export async function listPermissions({ roleId } = {}) {
  const role = await roleRepository.findById(roleId);
  if (!role) throw ApiError.notFound('Role not found');
  return roleRepository.listPermissionsForRole(roleId);
}

/** Escape regex metacharacters so user input can be a safe `$regex`. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  list,
  create,
  getById,
  update,
  remove,
  addPermission,
  removePermission,
  listPermissions,
  resolveActorRoles,
  _meta: { invalidatesCache: 'iam:rbac:<scope>' },
};
