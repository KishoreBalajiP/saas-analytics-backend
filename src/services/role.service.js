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
 *   - Permission grants and revocations are security events
 *     (`rbac.permission.granted` / `rbac.permission.revoked`).
 *   - All expected failures use `ApiError` factories.
 */

import ApiError from '../utils/ApiError.js';
import roleRepository from '../repositories/role.repository.js';
import permissionRepository from '../repositories/permission.repository.js';
import { invalidateScope, resolve } from './rbac.cache.service.js';
import adminRepository from '../repositories/admin.repository.js';
import { securityEvent } from './securityEvent.service.js';
import {
  LEGACY_PLATFORM_ROLE_NAMES,
  PLATFORM_ROLES,
  findPlatformRole,
  isBuiltInPlatformRole,
} from '../constants/platformRoles.js';

/** Names reserved for built-in (and legacy bootstrap) platform roles. */
const RESERVED_PLATFORM_ROLE_NAMES = new Set([
  ...PLATFORM_ROLES.map((r) => r.name),
  ...LEGACY_PLATFORM_ROLE_NAMES,
]);

/**
 * Built-in platform roles are defined in code (`constants/platformRoles.js`)
 * and converged by `npm run db:permissions`; their grants are not editable
 * over HTTP (create a custom role instead).
 */
function assertNotBuiltIn(role) {
  if (isBuiltInPlatformRole(role)) {
    throw ApiError.conflict('Built-in platform roles are managed by the role catalogue; create a custom role instead');
  }
}

/** Display metadata for a platform role row (built-in roles get labels). */
function decorate(role, permissionCount) {
  const definition = isBuiltInPlatformRole(role) ? findPlatformRole(role.name) : null;
  return {
    ...role,
    scope: role.tenantId == null ? 'platform' : 'tenant',
    builtIn: Boolean(definition),
    label: definition?.label ?? role.name,
    adminType: definition?.adminType ?? null,
    permissionCount,
  };
}

/**
 * Changing the permissions of a platform role (tenantId null) is a privilege
 * change for every admin who holds it, so only an active super admin may do
 * it. Requests attribute the actor by ObjectId; null or a non-ObjectId label
 * is an internal/system caller.
 */
async function assertMayEditRolePermissions({ role, by }) {
  const isPlatformRole = role.tenantId === null || role.tenantId === undefined;
  if (isPlatformRole && by && /^[0-9a-fA-F]{24}$/.test(String(by))) {
    const actorDoc = await adminRepository.findById(by);
    if (!actorDoc || actorDoc.status !== 'active' || actorDoc.adminType !== 'super') {
      throw ApiError.forbidden('Only an active super administrator can change platform role permissions');
    }
  }
}

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
  const result = await roleRepository.list({ tenantId, filter, page, limit });
  const counts = await roleRepository.countPermissionsForRoles(result.docs.map((r) => String(r._id)));
  return { ...result, docs: result.docs.map((r) => decorate(r, counts.get(String(r._id)) ?? 0)) };
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
  if (tenantId == null && RESERVED_PLATFORM_ROLE_NAMES.has(normalized)) {
    throw ApiError.conflict(`"${normalized}" is reserved for a built-in platform role`);
  }
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
  assertNotBuiltIn(role);
  await assertMayEditRolePermissions({ role, by });

  const joined = await roleRepository.attachPermission(roleId, permission._id, by);
  await invalidateScope(role.tenantId ?? null);
  if (!joined) return { alreadyGranted: true };
  await securityEvent('PERMISSION_GRANTED', {
    tenantId: role.tenantId ?? null,
    resource: { type: 'role', id: String(roleId) },
    metadata: { roleId: String(roleId), roleName: role.name, permission: permissionKey },
  });
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
  assertNotBuiltIn(role);
  if (role.tenantId === null || role.tenantId === undefined) await assertMayEditRolePermissions({ role, by });

  const removed = await roleRepository.detachPermission(roleId, permission._id);
  await invalidateScope(role.tenantId ?? null);
  if (removed > 0) {
    await securityEvent('PERMISSION_REVOKED', {
      tenantId: role.tenantId ?? null,
      resource: { type: 'role', id: String(roleId) },
      metadata: { roleId: String(roleId), roleName: role.name, permission: permissionKey },
    });
  }
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
