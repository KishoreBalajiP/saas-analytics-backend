/**
 * User Service (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Business logic for the tenant-user `/users` surface. Kept deliberately
 *   thin: self-service profile reads/writes plus a tenant-scoped read
 *   surface for tenant admins. Password/SSO flows stay in the auth module.
 *
 * RESPONSIBILITY
 *   - getProfile({ userId })            - self profile (secrets stripped)
 *   - updateProfile({ userId, patch })  - profile fields only
 *   - list({ tenantId, search })        - tenant-scoped paginated list
 *   - getById({ id, tenantId })         - tenant-scoped detail
 *   - deactivateMember / reactivateMember - member status lifecycle
 *     (roadmap 2.10; also the SSO/SCIM deprovisioning entry point)
 *
 * CODING GUIDELINES
 *   - Every read/write is tenant-scoped: the service REQUIRES `tenantId`
 *     from the caller (derived from the authenticated token, never the
 *     request body) - this is the primary multi-tenant defence.
 *   - `passwordHash` and lockout internals are never returned.
 */

import ApiError from '../utils/ApiError.js';
import userRepository from '../repositories/user.repository.js';
import roleService from './role.service.js';
import permissionService from './permission.service.js';
// members: member status lifecycle (roadmap 2.10).
import sessionRepository from '../repositories/session.repository.js';
import actorStatus from '../modules/iam/auth/actorStatus.service.js';
import { invalidateScope } from './rbac.cache.service.js';
import { emit as auditEmit } from './auditLog.service.js';
import { securityEvent } from './securityEvent.service.js';
import { withMembershipLock, assertKeepsAnOwner, syncOwnerId } from './tenantOwnership.service.js';

/** Profile fields a user may edit themselves. */
const PROFILE_FIELDS = ['name', 'locale', 'timezone', 'avatarUrl', 'phone'];

/** Strip auth/lockout internals from a lean user document. */
function stripSecrets(user) {
  if (!user) return user;
  const { passwordHash, failedAttempts, lockedUntil, ...safe } = user;
  return { ...safe, id: String(user._id) };
}

/**
 * Resolve the caller's effective roles and permission keys in their tenant.
 * The frontend gates navigation and actions on these lists, so the
 * profile endpoints must return them (the backend stays authoritative).
 */
async function resolveAccess(user) {
  if (!user?.tenantId) return { roles: [], permissions: [] };
  const scope = { actorType: 'user', actorId: String(user._id), tenantId: String(user.tenantId) };
  const [roles, permissions] = await Promise.all([
    roleService.resolveActorRoles(scope),
    permissionService.resolveActorPermissions(scope),
  ]);
  return { roles, permissions };
}

/**
 * Fetch the caller's own profile, including their effective roles and
 * permission keys in their tenant.
 *
 * @param {Object} opts
 * @param {string} opts.userId
 * @returns {Promise<Object>}
 */
export async function getProfile({ userId } = {}) {
  const user = await userRepository.findById(userId);
  if (!user) throw ApiError.notFound('User not found');
  return { ...stripSecrets(user), ...(await resolveAccess(user)) };
}

/**
 * Update the caller's own profile fields.
 *
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {Object} [opts.patch={}]
 * @returns {Promise<Object>} updated profile (plain, secrets stripped).
 */
export async function updateProfile({ userId, patch = {} } = {}) {
  const user = await userRepository.findById(userId);
  if (!user) throw ApiError.notFound('User not found');

  const set = {};
  for (const field of PROFILE_FIELDS) {
    if (patch[field] !== undefined) set[`profile.${field}`] = patch[field];
  }
  if (Object.keys(set).length === 0) throw ApiError.badRequest('Nothing to update');

  const updated = await userRepository.update(userId, set);
  return stripSecrets(updated);
}

/**
 * Paginated, tenant-scoped user list (for tenant-administration surfaces).
 *
 * @param {Object} opts
 * @param {string} opts.tenantId - REQUIRED; taken from the token, never the body.
 * @param {string} [opts.search]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Object>} paginated list with secrets stripped.
 */
export async function list({ tenantId, search, page = 1, limit = 20 } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const filter = {};
  if (search) filter['profile.name'] = { $regex: escapeRegExp(search), $options: 'i' };
  const result = await userRepository.list({ tenantId, filter, page, limit });
  return {
    ...result,
    docs: result.docs.map(stripSecrets),
  };
}

/**
 * Tenant-scoped user detail.
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @param {string} opts.tenantId - REQUIRED tenant scope.
 * @returns {Promise<Object>}
 */
export async function getById({ id, tenantId } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const user = await userRepository.findById(id);
  if (!user || user.tenantId !== tenantId) throw ApiError.notFound('User not found');
  return stripSecrets(user);
}

/* ------------------------------------------------------------------------ */
/* members: member status lifecycle (roadmap 2.10)                          */
/* ------------------------------------------------------------------------ */

const STATUS_ACTOR_TYPES = new Set(['user', 'admin', 'service', 'system']);

/**
 * Statuses a member can be deactivated from. `invited` people have not
 * joined (revoke the invitation instead) and `unverified` accounts would
 * skip email verification when reactivated, so neither qualifies.
 */
const DEACTIVATABLE = new Set(['active', 'locked']);

function statusActor(actorType, by) {
  const type = STATUS_ACTOR_TYPES.has(actorType) ? actorType : 'system';
  return { type, id: by ? String(by) : 'system' };
}

/** A live member of the tenant, or 404 (never reveals other tenants' users). */
async function findTenantMember(tenantId, userId) {
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
 * Deactivate a member: status `suspended`, every session revoked and the
 * per-request status cache dropped, so an access token they already hold
 * stops working on its next request. The seat stays taken (a deactivated
 * member is still a member). Refuses to deactivate the last active Owner.
 *
 * Authorization (who may deactivate whom) is the caller's job; pass `guard`
 * to run the caller's checks against the member inside the membership lock.
 * This is also the SSO/SCIM deprovisioning entry point.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.userId
 * @param {string|null} [opts.by] - actor id for attribution.
 * @param {'user'|'admin'|'service'|'system'} [opts.actorType='user']
 * @param {string|null} [opts.reason]
 * @param {(member: Object) => Promise<void>} [opts.guard]
 * @returns {Promise<{ member: Object, changed: boolean, sessionsRevoked: number }>}
 */
export async function deactivateMember({ tenantId, userId, by = null, actorType = 'user', reason = null, guard = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!userId) throw ApiError.badRequest('userId is required');
  return withMembershipLock(String(tenantId), async () => {
    const user = await findTenantMember(tenantId, userId);
    if (guard) await guard(user);
    if (user.status === 'suspended') return { member: stripSecrets(user), changed: false, sessionsRevoked: 0 };
    if (!DEACTIVATABLE.has(user.status)) {
      throw ApiError.conflict(user.status === 'invited'
        ? 'This person has not joined yet; revoke the invitation instead'
        : `A member in status "${user.status}" cannot be deactivated`);
    }
    await assertKeepsAnOwner({ tenantId, userId });
    const updated = await userRepository.suspend(String(userId), String(tenantId), by);
    if (!updated) throw ApiError.notFound('Member not found');
    const sessionsRevoked = await sessionRepository.revokeAllForActor(String(userId), 'member deactivated');
    actorStatus.invalidate('user', String(userId));
    await invalidateScope(String(tenantId));
    await syncOwnerId({ tenantId, by });
    const actor = statusActor(actorType, by);
    await auditEmit({
      actor,
      action: 'member.deactivated',
      module: 'iam.users',
      resource: { type: 'user', id: String(userId) },
      tenantId: String(tenantId),
      before: { status: user.status },
      after: { status: updated.status, sessionsRevoked },
      reason: reason ?? undefined,
    });
    await securityEvent('MEMBER_DEACTIVATED', {
      actor, tenantId: String(tenantId), reason: reason ?? undefined,
      metadata: { userId: String(userId), sessionsRevoked },
    });
    return { member: stripSecrets(updated), changed: true, sessionsRevoked };
  });
}

/**
 * Reactivate a deactivated (`suspended`) member. Consumes no seat: the seat
 * was never released on deactivation.
 *
 * @param {Object} opts - same as `deactivateMember`.
 * @returns {Promise<{ member: Object, changed: boolean }>}
 */
export async function reactivateMember({ tenantId, userId, by = null, actorType = 'user', reason = null, guard = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!userId) throw ApiError.badRequest('userId is required');
  return withMembershipLock(String(tenantId), async () => {
    const user = await findTenantMember(tenantId, userId);
    if (guard) await guard(user);
    if (user.status === 'active') return { member: stripSecrets(user), changed: false };
    if (user.status !== 'suspended') throw ApiError.conflict(`A member in status "${user.status}" cannot be reactivated`);
    const updated = await userRepository.restore(String(userId), String(tenantId), by);
    if (!updated) throw ApiError.notFound('Member not found');
    actorStatus.invalidate('user', String(userId));
    await invalidateScope(String(tenantId));
    await syncOwnerId({ tenantId, by });
    const actor = statusActor(actorType, by);
    await auditEmit({
      actor,
      action: 'member.reactivated',
      module: 'iam.users',
      resource: { type: 'user', id: String(userId) },
      tenantId: String(tenantId),
      before: { status: user.status },
      after: { status: updated.status },
      reason: reason ?? undefined,
    });
    await securityEvent('MEMBER_REACTIVATED', {
      actor, tenantId: String(tenantId), reason: reason ?? undefined, metadata: { userId: String(userId) },
    });
    return { member: stripSecrets(updated), changed: true };
  });
}

/** Escape regex metacharacters so user input can be a safe `$regex`. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  getProfile,
  updateProfile,
  list,
  getById,
  deactivateMember,
  reactivateMember,
  _meta: { tenancy: 'required-tenantId', stripSecrets: true },
};
