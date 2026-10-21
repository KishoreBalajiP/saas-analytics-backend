/**
 * Tenant Member Service (roadmap 2.10; finding ten.05).
 *
 * PURPOSE
 *   Workspace self-service member management for the tenant portal:
 *
 *   - listMembers / getMember   members with their roles and status
 *   - setMemberRoles            replace a member's (unscoped) role grants
 *   - deactivate / reactivate   status lifecycle (user.service.js does the
 *                               work; this layer authorises the actor)
 *   - removeMember              soft-delete the account, drop every grant
 *                               and session, give the seat back
 *
 * RULES (doc 05 section 4)
 *   - No self-modification: nobody changes their own roles or status or
 *     removes themselves here (ownership transfer is the way to step down).
 *   - Ceiling: an actor manages a member only when the member's effective
 *     permissions are a subset of the actor's, and only an Owner manages an
 *     Owner. A role can be granted only when its permissions are strictly
 *     below the actor's (an Owner may grant any role, including Owner).
 *   - Last owner: a change that would leave no active Owner is refused
 *     (409 LAST_OWNER); `Tenant.ownerId` follows the remaining Owners.
 *   - Every change runs under the tenant's membership lock, invalidates the
 *     tenant's RBAC scope (roles are resolved per request, never carried in
 *     tokens) and is audited.
 *
 * TENANCY
 *   `tenantId` always comes from the caller's token. A member id from
 *   another tenant answers 404, exactly like a missing one.
 */

import ApiError from '../utils/ApiError.js';
import { ERROR_CODES } from '../config/constants.js';
import userRepository from '../repositories/user.repository.js';
import roleRepository from '../repositories/role.repository.js';
import tenantRepository from '../repositories/tenant.repository.js';
import sessionRepository from '../repositories/session.repository.js';
import membershipRepository from '../repositories/membership.repository.js';
import actorStatus from '../modules/iam/auth/actorStatus.service.js';
import permissionService from './permission.service.js';
import usageService from './usage.service.js';
import userService from './user.service.js';
import { invalidateScope } from './rbac.cache.service.js';
import { emit as auditEmit } from './auditLog.service.js';
import { securityEvent } from './securityEvent.service.js';
import {
  OWNER_ROLE,
  withMembershipLock,
  assertKeepsAnOwner,
  syncOwnerId,
  findOwnerRole,
} from './tenantOwnership.service.js';

const MAX_ROLES_PER_MEMBER = 20;

function ceiling(message) {
  return new ApiError(403, message, { code: ERROR_CODES.ROLE_CEILING });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Effective permission keys of a tenant user (cached resolver). */
async function permissionsOf({ tenantId, userId }) {
  return new Set(await permissionService.resolveActorPermissions({
    actorType: 'user', actorId: String(userId), tenantId: String(tenantId),
  }));
}

/** Permission keys a role grants. */
async function rolePermissionKeys(roleId) {
  const rows = await roleRepository.listPermissionsForRole(String(roleId));
  return rows.map((p) => p.key ?? `${p.module}.${p.action}`);
}

function isSubset(keys, held) {
  for (const key of keys) if (!held.has(key)) return false;
  return true;
}

/** A tenant role of this tenant by id, or null. */
async function findTenantRole(tenantId, roleId) {
  let role = null;
  try {
    role = await roleRepository.findById(roleId);
  } catch (err) {
    if (err?.name !== 'CastError') throw err;
  }
  if (!role || String(role.tenantId) !== String(tenantId)) return null;
  return role;
}

/**
 * Throw unless `actorId` may manage `target` (no self-management, target's
 * permissions within the actor's, only an Owner manages an Owner).
 */
async function assertMayManage({ tenantId, actorId, target, ownerRole }) {
  if (String(target._id) === String(actorId)) {
    throw ApiError.forbidden('You cannot change your own membership. Ask another administrator, or transfer ownership.');
  }
  const [held, targetPerms] = await Promise.all([
    permissionsOf({ tenantId, userId: actorId }),
    permissionsOf({ tenantId, userId: target._id }),
  ]);
  if (ownerRole) {
    const targetRoles = await membershipRepository.listRoleIdsForUser({ tenantId, userId: target._id });
    if (targetRoles.includes(String(ownerRole._id))) {
      const actorRoles = await membershipRepository.listRoleIdsForUser({ tenantId, userId: actorId });
      if (!actorRoles.includes(String(ownerRole._id))) throw ceiling('Only an Owner can manage another Owner');
    }
  }
  if (!isSubset(targetPerms, held)) {
    throw ceiling('This member has permissions you do not hold, so you cannot manage them');
  }
  return held;
}

/** Member view: never exposes credentials; email only with `includeEmail`. */
function toMember(user, { roles = [], ownerId = null, ownerRoleId = null, includeEmail = true } = {}) {
  const roleIds = roles.map((r) => r.id);
  return {
    id: String(user._id),
    email: includeEmail ? user.email : null,
    name: user.profile?.name ?? '',
    status: user.status,
    roles,
    isOwner: ownerRoleId ? roleIds.includes(String(ownerRoleId)) : false,
    isPrimaryOwner: ownerId ? String(ownerId) === String(user._id) : false,
    lastLoginAt: user.lastLoginAt ?? null,
    joinedAt: user.acceptedAt ?? (user.status === 'invited' ? null : user.createdAt ?? null),
    createdAt: user.createdAt ?? null,
  };
}

/** Role id -> { id, name } for a set of ids. */
async function roleRefs(roleIds) {
  const out = new Map();
  for (const id of new Set(roleIds)) {
    const role = await roleRepository.findById(id).catch(() => null);
    if (role) out.set(String(role._id), { id: String(role._id), name: role.name });
  }
  return out;
}

/**
 * Members of a tenant with their roles.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string} [opts.search] - name or email substring.
 * @param {string} [opts.status] - one user status; default: everyone who
 *   joined (invitees are listed with the invitations).
 * @param {boolean} [opts.includeEmail=true] - false for name-only viewers.
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 */
export async function listMembers({ tenantId, search, status, includeEmail = true, page = 1, limit = 20 } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const filter = {};
  filter.status = status ? status : { $ne: 'invited' };
  if (search) {
    const term = { $regex: escapeRegExp(search), $options: 'i' };
    filter.$or = includeEmail ? [{ 'profile.name': term }, { email: term }] : [{ 'profile.name': term }];
  }
  const [result, tenant, ownerRole] = await Promise.all([
    userRepository.list({ tenantId: String(tenantId), filter, page, limit }),
    tenantRepository.findById(tenantId),
    findOwnerRole(tenantId),
  ]);
  const byUser = await membershipRepository.listRoleIdsForUsers({
    tenantId, userIds: result.docs.map((u) => String(u._id)),
  });
  const refs = await roleRefs([...byUser.values()].flat());
  return {
    ...result,
    docs: result.docs.map((user) => toMember(user, {
      roles: (byUser.get(String(user._id)) ?? []).map((id) => refs.get(id)).filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name)),
      ownerId: tenant?.ownerId ?? null,
      ownerRoleId: ownerRole?._id ?? null,
      includeEmail,
    })),
  };
}

/** One member of the tenant (404 for other tenants' users). */
export async function getMember({ tenantId, userId, includeEmail = true } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  let user = null;
  try {
    user = await userRepository.findById(userId);
  } catch (err) {
    if (err?.name !== 'CastError') throw err;
  }
  if (!user || String(user.tenantId) !== String(tenantId)) throw ApiError.notFound('Member not found');
  const [tenant, ownerRole, roleIds] = await Promise.all([
    tenantRepository.findById(tenantId),
    findOwnerRole(tenantId),
    membershipRepository.listRoleIdsForUser({ tenantId, userId }),
  ]);
  const refs = await roleRefs(roleIds);
  return toMember(user, {
    roles: roleIds.map((id) => refs.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)),
    ownerId: tenant?.ownerId ?? null,
    ownerRoleId: ownerRole?._id ?? null,
    includeEmail,
  });
}

async function loadMember(tenantId, userId) {
  let user = null;
  try {
    user = await userRepository.findById(userId);
  } catch (err) {
    if (err?.name !== 'CastError') throw err;
  }
  if (!user || String(user.tenantId) !== String(tenantId)) throw ApiError.notFound('Member not found');
  return user;
}

/**
 * Replace a member's roles (unscoped grants; scoped and temporary grants are
 * left alone).
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.userId
 * @param {string[]} opts.roleIds - at least one tenant role id.
 * @param {string} opts.by - the acting tenant user.
 * @returns {Promise<Object>} the member view.
 */
export async function setMemberRoles({ tenantId, userId, roleIds, by } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!Array.isArray(roleIds) || roleIds.length === 0) {
    throw ApiError.validation('Validation failed', [{ field: 'roleIds', message: 'Choose at least one role' }]);
  }
  const wanted = [...new Set(roleIds.map(String))];
  if (wanted.length > MAX_ROLES_PER_MEMBER) {
    throw ApiError.validation('Validation failed', [{ field: 'roleIds', message: `At most ${MAX_ROLES_PER_MEMBER} roles` }]);
  }

  const outcome = await withMembershipLock(String(tenantId), async () => {
    const target = await loadMember(tenantId, userId);
    if (target.status === 'invited') {
      throw ApiError.conflict('This person has not joined yet; revoke and re-send the invitation with another role');
    }
    const ownerRole = await findOwnerRole(tenantId);
    const held = await assertMayManage({ tenantId, actorId: by, target, ownerRole });
    const actorIsOwner = ownerRole
      ? (await membershipRepository.listRoleIdsForUser({ tenantId, userId: by })).includes(String(ownerRole._id))
      : false;

    const roles = [];
    for (const id of wanted) {
      const role = await findTenantRole(tenantId, id);
      if (!role) throw ApiError.validation('Validation failed', [{ field: 'roleIds', message: `Role ${id} does not exist in this workspace` }]);
      roles.push(role);
    }

    const current = await membershipRepository.listRoleIdsForUser({ tenantId, userId: target._id });
    const toAdd = roles.filter((r) => !current.includes(String(r._id)));
    const toRemove = current.filter((id) => !wanted.includes(id));
    if (toAdd.length === 0 && toRemove.length === 0) return { changed: false, added: [], removed: [] };

    // Granting: an Owner may grant anything; anyone else only roles whose
    // permissions are strictly below their own (doc 05: Admin assigns roles
    // below Admin). Owner itself is never granted by a non-Owner.
    for (const role of toAdd) {
      if (actorIsOwner) continue;
      if (ownerRole && String(role._id) === String(ownerRole._id)) throw ceiling('Only an Owner can grant the Owner role');
      const keys = await rolePermissionKeys(role._id);
      const strictlyBelow = isSubset(keys, held) && keys.length < held.size;
      if (!strictlyBelow) throw ceiling(`You cannot grant the "${role.name}" role because it is not below your own access`);
    }
    if (ownerRole && toRemove.includes(String(ownerRole._id))) {
      if (!actorIsOwner) throw ceiling('Only an Owner can remove the Owner role');
      await assertKeepsAnOwner({ tenantId, userId: target._id, ownerRole });
    }

    for (const role of toAdd) {
      await membershipRepository.addGrant({ tenantId, userId: target._id, roleId: role._id, by });
    }
    await membershipRepository.removeGrants({ tenantId, userId: target._id, roleIds: toRemove });
    await invalidateScope(String(tenantId));
    await syncOwnerId({ tenantId, by });

    const names = await roleRefs([...current, ...wanted]);
    const nameOf = (id) => names.get(String(id))?.name ?? String(id);
    return {
      changed: true,
      target,
      before: current.map(nameOf).sort(),
      after: wanted.map(nameOf).sort(),
      added: toAdd.map((r) => r.name),
      removed: toRemove.map(nameOf),
    };
  });

  if (outcome.changed) {
    const actor = { type: 'user', id: String(by) };
    await auditEmit({
      actor,
      action: 'member.roles_changed',
      module: 'iam.roles',
      resource: { type: 'user', id: String(userId) },
      tenantId: String(tenantId),
      before: { roles: outcome.before },
      after: { roles: outcome.after },
    });
    for (const role of outcome.added) {
      await securityEvent('ROLE_GRANTED', { actor, tenantId: String(tenantId), metadata: { userId: String(userId), role } });
    }
    for (const role of outcome.removed) {
      await securityEvent('ROLE_REVOKED', { actor, tenantId: String(tenantId), metadata: { userId: String(userId), role } });
    }
  }
  return getMember({ tenantId, userId });
}

/** Deactivate a member on behalf of a tenant user (ceiling enforced). */
export async function deactivate({ tenantId, userId, by, reason = null } = {}) {
  const ownerRole = await findOwnerRole(tenantId);
  const result = await userService.deactivateMember({
    tenantId,
    userId,
    by,
    actorType: 'user',
    reason,
    guard: (target) => assertMayManage({ tenantId, actorId: by, target, ownerRole }),
  });
  return { member: await getMember({ tenantId, userId }), changed: result.changed, sessionsRevoked: result.sessionsRevoked };
}

/** Reactivate a member on behalf of a tenant user (ceiling enforced). */
export async function reactivate({ tenantId, userId, by, reason = null } = {}) {
  const ownerRole = await findOwnerRole(tenantId);
  const result = await userService.reactivateMember({
    tenantId,
    userId,
    by,
    actorType: 'user',
    reason,
    guard: (target) => assertMayManage({ tenantId, actorId: by, target, ownerRole }),
  });
  return { member: await getMember({ tenantId, userId }), changed: result.changed };
}

/**
 * Remove a member from the workspace: the account is soft-deleted (so the
 * address can be invited again), every role grant and session is dropped,
 * the per-request status cache forgets the account and the seat is given
 * back. Content the member created stays with the workspace.
 *
 * @returns {Promise<{ removed: true, sessionsRevoked: number }>}
 */
export async function removeMember({ tenantId, userId, by, reason = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const outcome = await withMembershipLock(String(tenantId), async () => {
    const target = await loadMember(tenantId, userId);
    if (target.status === 'invited') throw ApiError.conflict('This person has not joined yet; revoke the invitation instead');
    const ownerRole = await findOwnerRole(tenantId);
    await assertMayManage({ tenantId, actorId: by, target, ownerRole });
    await assertKeepsAnOwner({ tenantId, userId: target._id, ownerRole });

    const deleted = await userRepository.softDelete(String(target._id), String(by));
    if (!deleted) throw ApiError.notFound('Member not found');
    const grantsRemoved = await membershipRepository.removeAllGrants({ tenantId, userId: target._id });
    const sessionsRevoked = await sessionRepository.revokeAllForActor(String(target._id), 'member removed');
    actorStatus.invalidate('user', String(target._id));
    await invalidateScope(String(tenantId));
    await usageService.release({ tenantId: String(tenantId), metric: 'members', requested: 1, by });
    await syncOwnerId({ tenantId, by });
    return { target, grantsRemoved, sessionsRevoked };
  });

  const actor = { type: 'user', id: String(by) };
  await auditEmit({
    actor,
    action: 'member.removed',
    module: 'iam.users',
    resource: { type: 'user', id: String(userId) },
    tenantId: String(tenantId),
    before: { status: outcome.target.status, email: outcome.target.email },
    after: { deleted: true, grantsRemoved: outcome.grantsRemoved, sessionsRevoked: outcome.sessionsRevoked },
    reason: reason ?? undefined,
  });
  await securityEvent('MEMBER_REMOVED', {
    actor,
    tenantId: String(tenantId),
    reason: reason ?? undefined,
    metadata: { userId: String(userId), grantsRemoved: outcome.grantsRemoved, sessionsRevoked: outcome.sessionsRevoked },
  });
  return { removed: true, sessionsRevoked: outcome.sessionsRevoked };
}

export default {
  OWNER_ROLE,
  listMembers,
  getMember,
  setMemberRoles,
  deactivate,
  reactivate,
  removeMember,
};
