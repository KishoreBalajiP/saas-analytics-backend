/**
 * Tenant Role Service (roadmap 2.10; finding ten.05).
 *
 * PURPOSE
 *   Workspace self-service role management. Platform roles are never touched
 *   here (they live in `role.service.js` behind adminAuth).
 *
 *   - listRoles              the tenant's roles with permission keys and
 *                            member counts
 *   - listPermissionCatalogue the tenant permission keys a custom role may
 *                            use, flagged with whether the actor holds them
 *   - createRole / updateRole / deleteRole   custom roles only
 *
 * RULES
 *   - Default roles (Owner, Admin, Manager, Viewer) are templates kept in
 *     step with the platform catalogue by `npm run db:permissions`; they
 *     are read-only here. Custom roles are fully editable.
 *   - Ceiling: an actor can only create or edit a role whose permissions
 *     (before and after the edit) they hold themselves.
 *   - Owner-only powers (`workspace.*`) can never be put in a custom role.
 *   - A role that is still assigned cannot be deleted (409).
 *   - Every change invalidates the tenant's RBAC scope (takes effect on the
 *     next request) and is audited.
 */

import ApiError from '../utils/ApiError.js';
import { ERROR_CODES } from '../config/constants.js';
import roleRepository from '../repositories/role.repository.js';
import permissionRepository from '../repositories/permission.repository.js';
import membershipRepository from '../repositories/membership.repository.js';
import permissionService from './permission.service.js';
import tenantInitialization from './tenantInitialization.service.js';
import { invalidateScope } from './rbac.cache.service.js';
import { emit as auditEmit } from './auditLog.service.js';
import { securityEvent } from './securityEvent.service.js';

/** Powers that stay with the Owner role (transfer, delete the workspace). */
export const OWNER_ONLY_PERMISSIONS = Object.freeze(['workspace.transfer', 'workspace.delete']);

const MAX_ROLES_PER_TENANT = 50;

function ceiling(message) {
  return new ApiError(403, message, { code: ERROR_CODES.ROLE_CEILING });
}

function defaultRoleNames() {
  return new Set(Object.keys(tenantInitialization.DEFAULT_ROLES ?? {}).map((n) => n.toLowerCase()));
}

/** Every tenant permission key in the catalogue (module.action). */
function catalogueKeys() {
  const keys = [];
  for (const [module, actions] of Object.entries(tenantInitialization.TENANT_PERMISSION_ACTIONS ?? {})) {
    for (const action of actions) keys.push(`${module}.${action}`);
  }
  return keys;
}

async function actorPermissions({ tenantId, actorId }) {
  return new Set(await permissionService.resolveActorPermissions({
    actorType: 'user', actorId: String(actorId), tenantId: String(tenantId),
  }));
}

async function permissionKeysOf(roleId) {
  const rows = await roleRepository.listPermissionsForRole(String(roleId));
  return rows.map((p) => p.key ?? `${p.module}.${p.action}`).sort();
}

function toRoleView(role, { permissions, memberCount }) {
  const isDefault = defaultRoleNames().has(String(role.name).toLowerCase());
  return {
    id: String(role._id),
    name: role.name,
    description: role.description ?? '',
    isSystem: Boolean(role.isSystem),
    isDefault,
    editable: !role.isSystem && !isDefault,
    permissions,
    memberCount,
    createdAt: role.createdAt ?? null,
    updatedAt: role.updatedAt ?? null,
  };
}

async function findTenantRole(tenantId, roleId) {
  let role = null;
  try {
    role = await roleRepository.findById(roleId);
  } catch (err) {
    if (err?.name !== 'CastError') throw err;
  }
  if (!role || String(role.tenantId) !== String(tenantId)) throw ApiError.notFound('Role not found');
  return role;
}

/**
 * Normalise and check a requested permission set: known tenant keys only,
 * no owner-only powers, all held by the actor.
 */
function checkPermissionSet(requested, held) {
  const known = new Set(catalogueKeys());
  const wanted = [...new Set((requested ?? []).map((k) => String(k).trim().toLowerCase()))].sort();
  const unknown = wanted.filter((k) => !known.has(k));
  if (unknown.length) {
    throw ApiError.validation('Validation failed', [{ field: 'permissions', message: `Unknown permissions: ${unknown.join(', ')}` }]);
  }
  const ownerOnly = wanted.filter((k) => OWNER_ONLY_PERMISSIONS.includes(k));
  if (ownerOnly.length) {
    throw ApiError.validation('Validation failed', [{ field: 'permissions', message: `Only the Owner role can hold: ${ownerOnly.join(', ')}` }]);
  }
  const missing = wanted.filter((k) => !held.has(k));
  if (missing.length) throw ceiling(`You cannot grant permissions you do not hold: ${missing.join(', ')}`);
  return wanted;
}

function validateName(name) {
  const normalized = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) throw ApiError.validation('Validation failed', [{ field: 'name', message: 'Role name is required' }]);
  if (normalized.length > 60) throw ApiError.validation('Validation failed', [{ field: 'name', message: 'Role name must be at most 60 characters' }]);
  if (defaultRoleNames().has(normalized.toLowerCase())) {
    throw ApiError.validation('Validation failed', [{ field: 'name', message: `"${normalized}" is a built-in role name` }]);
  }
  return normalized;
}

async function attachKeys(roleId, keys, by) {
  for (const key of keys) {
    const permission = await permissionRepository.findPermissionByKey(key);
    if (!permission) {
      throw ApiError.validation('Validation failed', [{ field: 'permissions', message: `Permission ${key} is not provisioned yet` }]);
    }
    await roleRepository.attachPermission(roleId, permission._id, by);
  }
}

async function detachKeys(roleId, keys) {
  for (const key of keys) {
    const permission = await permissionRepository.findPermissionByKey(key);
    if (permission) await roleRepository.detachPermission(roleId, permission._id);
  }
}

/** The tenant's roles with their permission keys and member counts. */
export async function listRoles({ tenantId } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const { docs } = await roleRepository.list({ tenantId: String(tenantId), page: 1, limit: MAX_ROLES_PER_TENANT + 10 });
  const counts = await membershipRepository.countHoldersByRole({ tenantId, roleIds: docs.map((r) => String(r._id)) });
  const order = ['owner', 'admin', 'manager', 'viewer'];
  const views = [];
  for (const role of docs) {
    views.push(toRoleView(role, { permissions: await permissionKeysOf(role._id), memberCount: counts.get(String(role._id)) ?? 0 }));
  }
  return views.sort((a, b) => {
    const ia = order.indexOf(a.name.toLowerCase());
    const ib = order.indexOf(b.name.toLowerCase());
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.name.localeCompare(b.name);
  });
}

/** One tenant role. */
export async function getRole({ tenantId, roleId } = {}) {
  const role = await findTenantRole(tenantId, roleId);
  const counts = await membershipRepository.countHoldersByRole({ tenantId, roleIds: [String(role._id)] });
  return toRoleView(role, { permissions: await permissionKeysOf(role._id), memberCount: counts.get(String(role._id)) ?? 0 });
}

/**
 * Permission keys a custom role may use, grouped for the role editor.
 *
 * @returns {Promise<Array<{ key, module, action, description, held, assignable }>>}
 */
export async function listPermissionCatalogue({ tenantId, actorId } = {}) {
  const held = await actorPermissions({ tenantId, actorId });
  const keys = catalogueKeys();
  const { docs } = await permissionRepository.listPermissions({ filter: { key: { $in: keys } }, page: 1, limit: keys.length + 10 });
  const provisioned = new Map(docs.map((p) => [p.key, p]));
  const out = [];
  for (const key of keys) {
    const [module, action] = [key.slice(0, key.lastIndexOf('.')), key.slice(key.lastIndexOf('.') + 1)];
    const permission = provisioned.get(key);
    if (!permission) continue;
    const ownerOnly = OWNER_ONLY_PERMISSIONS.includes(key);
    out.push({
      key,
      module,
      action,
      description: permission.description ?? '',
      held: held.has(key),
      assignable: !ownerOnly && held.has(key),
    });
  }
  return out;
}

/** Create a custom role within the actor's ceiling. */
export async function createRole({ tenantId, name, description = '', permissions = [], by } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const normalized = validateName(name);
  const held = await actorPermissions({ tenantId, actorId: by });
  const keys = checkPermissionSet(permissions, held);
  if (keys.length === 0) {
    throw ApiError.validation('Validation failed', [{ field: 'permissions', message: 'Choose at least one permission' }]);
  }
  const { total } = await roleRepository.list({ tenantId: String(tenantId), page: 1, limit: 1 });
  if (total >= MAX_ROLES_PER_TENANT) throw ApiError.conflict(`A workspace can have at most ${MAX_ROLES_PER_TENANT} roles`);
  if (await roleRepository.findByName({ tenantId: String(tenantId), name: normalized })) {
    throw ApiError.conflict(`A role named "${normalized}" already exists`);
  }
  let role;
  try {
    role = await roleRepository.create({
      tenantId: String(tenantId),
      name: normalized,
      description: String(description ?? '').trim(),
      level: 'tenant',
      isSystem: false,
      createdBy: String(by),
    });
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict(`A role named "${normalized}" already exists`);
    throw err;
  }
  await attachKeys(role._id, keys, String(by));
  await invalidateScope(String(tenantId));
  const actor = { type: 'user', id: String(by) };
  await auditEmit({
    actor,
    action: 'role.created',
    module: 'iam.roles',
    resource: { type: 'role', id: String(role._id) },
    tenantId: String(tenantId),
    after: { name: normalized, permissions: keys },
  });
  await securityEvent('TENANT_ROLE_CHANGED', {
    actor, tenantId: String(tenantId), metadata: { op: 'created', roleId: String(role._id), name: normalized, permissions: keys },
  });
  return getRole({ tenantId, roleId: role._id });
}

/** Rename / re-describe / change the permissions of a custom role. */
export async function updateRole({ tenantId, roleId, patch = {}, by } = {}) {
  const role = await findTenantRole(tenantId, roleId);
  const view = await getRole({ tenantId, roleId });
  if (!view.editable) throw ApiError.conflict('Built-in roles cannot be changed here');
  const held = await actorPermissions({ tenantId, actorId: by });
  if (view.permissions.some((k) => !held.has(k))) {
    throw ceiling('This role has permissions you do not hold, so you cannot change it');
  }

  const set = {};
  if (patch.name !== undefined) {
    const normalized = validateName(patch.name);
    if (normalized !== role.name) {
      const clash = await roleRepository.findByName({ tenantId: String(tenantId), name: normalized });
      if (clash && String(clash._id) !== String(role._id)) throw ApiError.conflict(`A role named "${normalized}" already exists`);
      set.name = normalized;
    }
  }
  if (patch.description !== undefined) set.description = String(patch.description ?? '').trim();

  let added = [];
  let removed = [];
  if (patch.permissions !== undefined) {
    const keys = checkPermissionSet(patch.permissions, held);
    if (keys.length === 0) {
      throw ApiError.validation('Validation failed', [{ field: 'permissions', message: 'Choose at least one permission' }]);
    }
    added = keys.filter((k) => !view.permissions.includes(k));
    removed = view.permissions.filter((k) => !keys.includes(k));
  }
  if (Object.keys(set).length === 0 && added.length === 0 && removed.length === 0) return view;

  if (Object.keys(set).length) {
    try {
      await roleRepository.update(String(role._id), { ...set, updatedBy: String(by) });
    } catch (err) {
      if (err?.code === 11000) throw ApiError.conflict(`A role named "${set.name}" already exists`);
      throw err;
    }
  }
  await attachKeys(role._id, added, String(by));
  await detachKeys(role._id, removed);
  await invalidateScope(String(tenantId));

  const actor = { type: 'user', id: String(by) };
  const after = await getRole({ tenantId, roleId });
  await auditEmit({
    actor,
    action: 'role.updated',
    module: 'iam.roles',
    resource: { type: 'role', id: String(role._id) },
    tenantId: String(tenantId),
    before: { name: view.name, description: view.description, permissions: view.permissions },
    after: { name: after.name, description: after.description, permissions: after.permissions },
  });
  await securityEvent('TENANT_ROLE_CHANGED', {
    actor,
    tenantId: String(tenantId),
    metadata: { op: 'updated', roleId: String(role._id), name: after.name, added, removed },
  });
  return after;
}

/** Delete an unassigned custom role. */
export async function deleteRole({ tenantId, roleId, by } = {}) {
  const role = await findTenantRole(tenantId, roleId);
  const view = await getRole({ tenantId, roleId });
  if (!view.editable) throw ApiError.conflict('Built-in roles cannot be deleted');
  const held = await actorPermissions({ tenantId, actorId: by });
  if (view.permissions.some((k) => !held.has(k))) {
    throw ceiling('This role has permissions you do not hold, so you cannot delete it');
  }
  const assignments = await roleRepository.countAssignments(String(role._id));
  if (assignments > 0) {
    throw ApiError.conflict(`This role is assigned to ${assignments} member(s); change their roles first`);
  }
  await roleRepository.softDelete(String(role._id), String(by));
  await roleRepository.clearPermissions(String(role._id));
  await invalidateScope(String(tenantId));
  const actor = { type: 'user', id: String(by) };
  await auditEmit({
    actor,
    action: 'role.deleted',
    module: 'iam.roles',
    resource: { type: 'role', id: String(role._id) },
    tenantId: String(tenantId),
    before: { name: view.name, permissions: view.permissions },
  });
  await securityEvent('TENANT_ROLE_CHANGED', {
    actor, tenantId: String(tenantId), metadata: { op: 'deleted', roleId: String(role._id), name: view.name },
  });
  return { deleted: true };
}

export default {
  OWNER_ONLY_PERMISSIONS,
  listRoles,
  getRole,
  listPermissionCatalogue,
  createRole,
  updateRole,
  deleteRole,
};
