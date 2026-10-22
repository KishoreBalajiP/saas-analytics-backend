/**
 * Tenant Ownership Service (roadmap 2.10; findings ten.05, ten.07).
 *
 * PURPOSE
 *   Ownership is a first-class rule, not a label: a workspace always keeps at
 *   least one active member holding the `Owner` role, and `Tenant.ownerId`
 *   always names one of them. This module holds the pieces every membership
 *   change shares:
 *
 *   - withMembershipLock(tenantId, fn)  serialises membership changes of one
 *                                       tenant (the last-owner check and the
 *                                       write must not interleave)
 *   - assertKeepsAnOwner(...)           409 LAST_OWNER when a change would
 *                                       leave no active Owner
 *   - syncOwnerId(...)                  re-point `ownerId` at an active Owner
 *   - verifyStepUp(...)                 password re-entry for destructive
 *                                       actions (403 STEP_UP_FAILED)
 *   - transferOwnership(...)            grant Owner to an active member and
 *                                       downgrade the previous owner, audited
 *
 * TRANSFER SEQUENCE (no multi-document transactions on a standalone server)
 *   Under the tenant's membership lock:
 *     1. grant Owner to the new owner;
 *     2. compare-and-set `Tenant.ownerId` (the commit point: a concurrent
 *        transfer loses here and step 1 is rolled back);
 *     3. remove Owner from the previous owner and grant Admin.
 *   A failure after step 2 leaves two owners, which is safe (never zero) and
 *   is repaired by repeating the transfer. Roles are not carried in access
 *   tokens, so invalidating the RBAC scope makes the change effective on the
 *   very next request of both members.
 */

import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { ERROR_CODES } from '../config/constants.js';
import { verify as verifyPassword } from '../utils/password.js';
import { getJobLock } from '../jobs/lock.js';
import { getInstanceId } from '../jobs/runtime.js';
import tenantRepository from '../repositories/tenant.repository.js';
import userRepository from '../repositories/user.repository.js';
import roleRepository from '../repositories/role.repository.js';
import membershipRepository from '../repositories/membership.repository.js';
import { invalidateScope } from './rbac.cache.service.js';
import { emit as auditEmit } from './auditLog.service.js';
import { securityEvent } from './securityEvent.service.js';

export const OWNER_ROLE = 'Owner';
export const ADMIN_ROLE = 'Admin';

const LOCK_LEASE_MS = 15000;
const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 50;

function typed(status, message, code) {
  return new ApiError(status, message, { code });
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A user by id, or null for a malformed id. */
async function findUser(userId) {
  try {
    return await userRepository.findById(userId);
  } catch (err) {
    if (err?.name === 'CastError') return null;
    throw err;
  }
}

/**
 * Run `fn` while holding the tenant's membership lock. Waits briefly for a
 * concurrent change to finish; answers 409 MEMBERSHIP_BUSY when it does not,
 * and 503 when the lock backend is unreachable (fail closed).
 */
export async function withMembershipLock(tenantId, fn, { lock = getJobLock(), waitMs = LOCK_WAIT_MS } = {}) {
  const key = `tenant-members:${tenantId}`;
  const owner = getInstanceId();
  const deadline = Date.now() + waitMs;
  let token = null;
  for (;;) {
    try {
      token = await lock.acquire(key, { owner, leaseMs: LOCK_LEASE_MS });
    } catch (err) {
      logger.warn({ err: { message: err?.message } }, 'membership lock unavailable');
      throw ApiError.serviceUnavailable('Membership changes are temporarily unavailable; try again shortly');
    }
    if (token) break;
    if (Date.now() >= deadline) {
      throw typed(409, 'Another membership change is in progress; try again', ERROR_CODES.MEMBERSHIP_BUSY);
    }
    await sleep(LOCK_POLL_MS);
  }
  try {
    return await fn();
  } finally {
    await Promise.resolve()
      .then(() => lock.release(key, token))
      .catch((err) => logger.warn({ err: { message: err?.message } }, 'membership lock release failed'));
  }
}

/** The tenant's Owner role (or null when the tenant was never initialised). */
export function findOwnerRole(tenantId) {
  return roleRepository.findByName({ tenantId: String(tenantId), name: OWNER_ROLE });
}

/** Whether a member currently holds the Owner role. */
export async function holdsOwner({ tenantId, userId, ownerRole = null }) {
  const role = ownerRole ?? (await findOwnerRole(tenantId));
  if (!role) return false;
  const roleIds = await membershipRepository.listRoleIdsForUser({ tenantId, userId });
  return roleIds.includes(String(role._id));
}

/**
 * Refuse a change that would leave the tenant without an active Owner: when
 * `userId` is an active Owner, another active Owner must exist.
 */
export async function assertKeepsAnOwner({ tenantId, userId, ownerRole = null }) {
  const role = ownerRole ?? (await findOwnerRole(tenantId));
  if (!role) return;
  const user = await findUser(userId);
  if (!user || user.status !== 'active') return;
  if (!(await holdsOwner({ tenantId, userId, ownerRole: role }))) return;
  const others = await membershipRepository.countActiveHolders({
    tenantId, roleId: String(role._id), excludeUserIds: [String(userId)],
  });
  if (others === 0) {
    throw typed(409, 'A workspace must keep at least one active Owner. Transfer ownership first.', ERROR_CODES.LAST_OWNER);
  }
}

/**
 * Keep `Tenant.ownerId` pointing at an active Owner. When the current value
 * no longer qualifies (removed, deactivated or demoted), move it to another
 * active Owner. No-op when it still qualifies or no Owner exists.
 */
export async function syncOwnerId({ tenantId, by = null }) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) return null;
  const role = await findOwnerRole(tenantId);
  if (!role) return tenant;
  const holders = await membershipRepository.listHolderIds({ tenantId, roleId: String(role._id) });
  const active = [];
  for (const id of holders) {
    const user = await findUser(id);
    if (user && user.status === 'active' && String(user.tenantId) === String(tenantId)) active.push(id);
  }
  if (tenant.ownerId && active.includes(String(tenant.ownerId))) return tenant;
  if (active.length === 0) return tenant;
  const updated = await tenantRepository.compareAndSetOwner(tenantId, { expected: tenant.ownerId ?? null, next: active[0], by });
  return updated ?? tenant;
}

/**
 * Password re-entry for destructive actions. Throws 403 STEP_UP_FAILED (and
 * records a security event) on a wrong or missing password. Accounts
 * without a password (SSO-only) cannot pass a password step-up.
 */
export async function verifyStepUp({ tenantId, userId, password }) {
  const user = await findUser(userId);
  const ok = Boolean(
    user
    && String(user.tenantId) === String(tenantId)
    && typeof password === 'string'
    && password.length > 0
    && user.passwordHash
    && (await verifyPassword(password, user.passwordHash)),
  );
  if (!ok) {
    await securityEvent('STEP_UP_FAILED', {
      actor: { type: 'user', id: String(userId) },
      tenantId: String(tenantId),
      reason: user?.passwordHash ? 'password_mismatch' : 'no_password',
    });
    throw new ApiError(403, 'Password confirmation failed', {
      code: ERROR_CODES.STEP_UP_FAILED,
      errors: [{ field: 'password', message: 'The password is not correct' }],
    });
  }
  return true;
}

/**
 * Transfer workspace ownership to an active member.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.toUserId - the new owner (active member of the tenant).
 * @param {string} opts.by - actor id (tenant user or platform admin).
 * @param {'user'|'admin'} [opts.actorType='user'] - a user must hold Owner;
 *   a platform admin is the audited break-glass path.
 * @param {string|null} [opts.reason]
 * @returns {Promise<{ tenant: Object, previousOwnerId: string|null, newOwnerId: string }>}
 */
export async function transferOwnership({ tenantId, toUserId, by, actorType = 'user', reason = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!toUserId) throw ApiError.badRequest('userId is required');
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');
  if (tenant.status === 'archived') throw ApiError.conflict('Archived tenants cannot change owner');

  return withMembershipLock(String(tenantId), async () => {
    const ownerRole = await findOwnerRole(tenantId);
    if (!ownerRole) throw ApiError.conflict('This workspace has no Owner role; initialise it first');

    const target = await findUser(toUserId);
    if (!target || String(target.tenantId) !== String(tenantId)) throw ApiError.notFound('User not found in this tenant');
    if (target.status !== 'active') throw ApiError.conflict('The new owner must be an active member');

    const current = await tenantRepository.findById(tenantId);
    if (!current) throw ApiError.notFound('Tenant not found');

    let fromUserId;
    if (actorType === 'user') {
      if (String(by) === String(toUserId)) throw ApiError.badRequest('You already own this workspace');
      if (!(await holdsOwner({ tenantId, userId: by, ownerRole }))) {
        throw ApiError.forbidden('Only a workspace Owner can transfer ownership');
      }
      fromUserId = String(by);
    } else {
      fromUserId = current.ownerId && String(current.ownerId) !== String(toUserId) ? String(current.ownerId) : null;
    }

    const granted = await membershipRepository.addGrant({ tenantId, userId: toUserId, roleId: String(ownerRole._id), by });
    const updated = await tenantRepository.compareAndSetOwner(tenantId, {
      expected: current.ownerId ?? null, next: String(toUserId), by,
    });
    if (!updated) {
      if (granted) await membershipRepository.removeGrants({ tenantId, userId: toUserId, roleIds: [String(ownerRole._id)] });
      throw typed(409, 'Workspace ownership changed meanwhile; reload and try again', ERROR_CODES.MEMBERSHIP_BUSY);
    }

    let demoted = false;
    if (fromUserId && fromUserId !== String(toUserId)) {
      const removed = await membershipRepository.removeGrants({ tenantId, userId: fromUserId, roleIds: [String(ownerRole._id)] });
      demoted = removed > 0;
      // Only a previous Owner is downgraded to Admin; a stale `ownerId` that
      // never held Owner must not gain anything here.
      const adminRole = demoted ? await roleRepository.findByName({ tenantId: String(tenantId), name: ADMIN_ROLE }) : null;
      if (adminRole) await membershipRepository.addGrant({ tenantId, userId: fromUserId, roleId: String(adminRole._id), by });
    }
    await invalidateScope(String(tenantId));

    const actor = { type: actorType === 'admin' ? 'admin' : 'user', id: String(by ?? 'system') };
    await auditEmit({
      actor,
      action: 'tenant.owner_changed',
      module: 'iam.tenants',
      resource: { type: 'tenant', id: String(tenantId) },
      tenantId: String(tenantId),
      before: { ownerId: current.ownerId ?? null },
      after: { ownerId: String(toUserId), previousOwnerId: fromUserId, previousOwnerDemotedTo: demoted ? ADMIN_ROLE : null },
      reason: reason ?? (actorType === 'admin' ? 'Platform ownership reassignment' : 'Ownership transferred by the owner'),
    });
    await securityEvent('OWNERSHIP_TRANSFERRED', {
      actor,
      tenantId: String(tenantId),
      reason: reason ?? undefined,
      metadata: { fromUserId, toUserId: String(toUserId), demoted },
    });
    if (granted) {
      await securityEvent('ROLE_GRANTED', {
        actor, tenantId: String(tenantId), metadata: { userId: String(toUserId), role: OWNER_ROLE },
      });
    }
    if (demoted) {
      await securityEvent('ROLE_REVOKED', {
        actor, tenantId: String(tenantId), metadata: { userId: fromUserId, role: OWNER_ROLE },
      });
    }
    return { tenant: updated, previousOwnerId: fromUserId, newOwnerId: String(toUserId) };
  });
}

export default {
  OWNER_ROLE,
  ADMIN_ROLE,
  withMembershipLock,
  findOwnerRole,
  holdsOwner,
  assertKeepsAnOwner,
  syncOwnerId,
  verifyStepUp,
  transferOwnership,
};
