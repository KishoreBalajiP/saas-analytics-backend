/**
 * Tenant Invitation Service.
 *
 * LIFECYCLE (roadmap 2.10, ten.12)
 *   - create   pending invitation + provisional role grant; takes one
 *              `members` seat (an invitee holds a seat while pending)
 *   - resend   re-issues the link of a pending invitation in place (new
 *              token, new expiry, `resendCount + 1`); the seat is kept. An
 *              `expired` invitation is re-created instead (takes a seat).
 *   - revoke   pending -> revoked; drops the provisional grant and gives the
 *              seat back
 *   - accept   pending -> accepted; activates the invited account
 *   - expireDue (sweep) pending past `expiresAt` -> expired; drops the
 *              provisional grant and gives the seat back
 *   Rows are history and are never deleted by a TTL index. The link
 *   lifetime is `INVITATION_TTL_DAYS` (env.members.invitationTtlDays).
 *
 * CEILING
 *   A tenant user may only create, resend or revoke invitations for a role
 *   whose permissions they hold themselves. Platform admins skip the check.
 */

import { createHash, randomBytes } from 'node:crypto';
import env from '../config/env.js';
import usageService from './usage.service.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { hash as hashPassword } from '../utils/password.js';
import outboxService from './outbox.service.js';
import tenantRepository from '../repositories/tenant.repository.js';
import userRepository from '../repositories/user.repository.js';
import roleRepository from '../repositories/role.repository.js';
import invitationRepository from '../repositories/tenantInvitation.repository.js';
import { UserRole } from '../models/UserRole.js';
import { TenantInvitation } from '../models/TenantInvitation.js';
import { emit as auditEmit } from './auditLog.service.js';
import permissionService from './permission.service.js';
import { invalidateScope } from './rbac.cache.service.js';
import { ERROR_CODES } from '../config/constants.js';
import { securityEvent } from './securityEvent.service.js';
import { describeDuration } from '../utils/humanDuration.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long an invitation link stays valid (ms). */
export function invitationTtlMs() {
  return Math.max(1, Number(env.members?.invitationTtlDays) || 7) * DAY_MS;
}
const INVALID = 'Invitation is invalid, expired, or no longer available';

function digest(token) { return createHash('sha256').update(token, 'utf8').digest('hex'); }
function safeInvitation(row) {
  if (!row) return row;
  const { tokenHash, ...safe } = row;
  return safe;
}

function acceptUrl(rawToken) {
  return `${env.cors.clientUrl}/invite/accept?token=${encodeURIComponent(rawToken)}`;
}

async function sendInvitationEmail({ tenantId, invitationId, to, tenantName, rawToken }) {
  try {
    // retention: recorded in the email outbox and attempted now; a failed
    // attempt is retried by the email job. Each token gets its own key, so a
    // resend is a new message rather than a duplicate of the first.
    const outcome = await outboxService.sendNow({
      tenantId: String(tenantId),
      to,
      template: 'tenant.invitation',
      variables: { tenantName, acceptUrl: acceptUrl(rawToken), expiresIn: describeDuration(invitationTtlMs()) },
      idempotencyKey: `tenant-invitation:${String(invitationId)}:${digest(rawToken).slice(0, 16)}`,
    });
    if (!outcome.delivered) throw new Error(outcome.error?.message ?? 'Email delivery failed');
    return { delivered: true, error: null };
  } catch (error) {
    // Do not log the token or email body. The pending invitation can be resent.
    return { delivered: false, error: error?.message ?? 'Email delivery failed' };
  }
}

async function resolveRole(tenantId, roleName = 'Owner') {
  const role = await roleRepository.findByName({ tenantId, name: roleName });
  if (!role) throw ApiError.badRequest('Invitation role is not available for this tenant');
  return role;
}

async function ensureInvitedUser({ tenantId, email, name = '', invitedBy }) {
  let user = await userRepository.findByEmail(tenantId, email);
  if (!user) {
    user = await userRepository.create({
      tenantId, email, passwordHash: null, status: 'invited',
      profile: { name, locale: 'en', timezone: 'UTC' }, invitedBy,
    });
  }
  return user;
}

/**
 * Role ceiling for tenant-user inviters: the invited role's permissions
 * must be a subset of the inviter's own effective permissions. This stops
 * an Admin (no `roles.*`) from inviting an Owner. Platform admins
 * (actorType 'admin') are trusted operators and skip the check.
 */
async function assertInviterMayGrant({ tenantId, role, invitedBy, actorType, verb = 'invite someone with' }) {
  if (actorType !== 'user') return;
  const [inviterPermissions, rolePermissions] = await Promise.all([
    permissionService.resolveActorPermissions({ actorType: 'user', actorId: String(invitedBy), tenantId: String(tenantId) }),
    roleRepository.listPermissionsForRole(String(role._id)),
  ]);
  const held = new Set(inviterPermissions);
  const missing = rolePermissions
    .map((p) => p.key ?? `${p.module}.${p.action}`)
    .filter((key) => !held.has(key));
  if (missing.length > 0) {
    throw new ApiError(403, `You cannot ${verb} the "${role.name}" role because it has permissions you do not hold`, { code: ERROR_CODES.ROLE_CEILING });
  }
}

/** Remove every role grant an invited (not yet active) user holds in the tenant. */
async function clearProvisionalGrants({ tenantId, userId }) {
  const result = await UserRole.deleteMany({ tenantId, userId });
  await invalidateScope(String(tenantId));
  if (result?.deletedCount > 0) {
    await securityEvent('ROLE_REVOKED', {
      tenantId: String(tenantId),
      resource: { type: 'user', id: String(userId) },
      reason: 'invitation_revoked',
      metadata: { granteeType: 'user', granteeId: String(userId), count: result.deletedCount, provisional: true },
    });
  }
}

async function ensureRoleGrant({ tenantId, userId, roleId, by }) {
  try {
    await new UserRole({ tenantId, userId, roleId, grantedBy: by, grantedAt: new Date() }).save();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return;
  }
  await securityEvent('ROLE_GRANTED', {
    tenantId: String(tenantId),
    resource: { type: 'user', id: String(userId) },
    reason: 'invitation',
    metadata: { granteeType: 'user', granteeId: String(userId), roleId: String(roleId), grantedBy: by ? String(by) : null, provisional: true },
  });
}

/**
 * Drop the provisional access of an invitee who never joined and give the
 * seat back. No-op when the person already joined (or was removed).
 *
 * @returns {Promise<boolean>} whether a seat was released.
 */
async function releaseInvitee({ tenantId, invitedEmail, by }) {
  const user = await userRepository.findByEmail(String(tenantId), invitedEmail);
  if (!user || user.status !== 'invited') return false;
  await clearProvisionalGrants({ tenantId: String(tenantId), userId: String(user._id) });
  await usageService.release({ tenantId: String(tenantId), metric: 'members', requested: 1, by });
  return true;
}

async function findTenantInvitation({ id, tenantId }) {
  let row = null;
  try {
    row = await invitationRepository.findById(id);
  } catch (err) {
    if (err?.name !== 'CastError') throw err;
  }
  if (!row || String(row.tenantId) !== String(tenantId)) throw ApiError.notFound('Invitation not found');
  return row;
}

export async function create({ tenantId, email, name = '', roleName = 'Owner', invitedBy, actorType = 'admin' }) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');
  if (!invitedBy) throw ApiError.badRequest('Inviter is required');
  const invitedEmail = String(email ?? '').trim().toLowerCase();
  if (!invitedEmail) throw ApiError.badRequest('Invited email is required');
  const existing = await invitationRepository.findPendingByEmail({ tenantId, invitedEmail });
  if (existing && existing.expiresAt > new Date()) {
    return { invitation: safeInvitation(existing), delivered: false, alreadyPending: true };
  }
  const role = await resolveRole(tenantId, roleName);
  await assertInviterMayGrant({ tenantId, role, invitedBy, actorType });
  const priorUser = await userRepository.findByEmail(tenantId, invitedEmail);
  if (priorUser && priorUser.status !== 'invited') throw ApiError.conflict('A user with this email already belongs to the tenant');
  // Seats: an invitee holds a seat while a pending invitation exists. Take a
  // seat unless this replaces a pending (lapsed, not yet swept) invitation
  // that already holds one; revoked and expired invitations gave theirs back.
  const takesSeat = !existing;
  if (takesSeat) await usageService.checkAndConsume({ tenantId, metric: 'members', requested: 1, by: invitedBy });
  const releaseSeat = () => (takesSeat ? usageService.release({ tenantId, metric: 'members', requested: 1, by: invitedBy }) : null);
  let user;
  try {
    if (existing) await invitationRepository.revokePending({ tenantId, invitedEmail, by: invitedBy });
    user = await ensureInvitedUser({ tenantId, email: invitedEmail, name, invitedBy });
    // A re-invite replaces the invitee's role instead of accumulating grants.
    if (priorUser) await clearProvisionalGrants({ tenantId, userId: String(user._id) });
    await ensureRoleGrant({ tenantId, userId: String(user._id), roleId: String(role._id), by: invitedBy });
    await invalidateScope(String(tenantId));
  } catch (error) {
    await releaseSeat();
    throw error;
  }
  const rawToken = randomBytes(32).toString('base64url');
  let invitation;
  try {
    invitation = await invitationRepository.create({
      tenantId, invitedEmail, roleId: String(role._id), roleName: role.name,
      invitedBy: String(invitedBy), tokenHash: digest(rawToken),
      expiresAt: new Date(Date.now() + invitationTtlMs()),
      lastSentAt: new Date(),
    });
  } catch (error) {
    // The seat taken above is not used by this call (a concurrent invite won).
    await releaseSeat();
    if (error?.code !== 11000) throw error;
    const pending = await invitationRepository.findPendingByEmail({ tenantId, invitedEmail });
    if (!pending) throw error;
    return { invitation: safeInvitation(pending), delivered: false, alreadyPending: true };
  }
  const sent = await sendInvitationEmail({ tenantId, invitationId: invitation._id, to: invitedEmail, tenantName: tenant.name, rawToken });
  if (!sent.delivered) invitation.deliveryError = sent.error;
  await auditEmit({ actor: { type: actorType, id: invitedBy }, action: 'tenant.invitation_created', module: 'iam.tenant_invitations', resource: { type: 'invitation', id: invitation._id }, tenantId, after: { invitedEmail, role: role.name, delivered: sent.delivered } });
  return { invitation: safeInvitation(invitation), delivered: sent.delivered };
}

export async function preview(token) {
  const row = await invitationRepository.findLiveByHash(digest(String(token ?? '')));
  if (!row) throw ApiError.badRequest(INVALID);
  const tenant = await tenantRepository.findById(row.tenantId);
  if (!tenant) throw ApiError.badRequest(INVALID);
  return { tenant: { id: String(tenant._id), name: tenant.name, slug: tenant.slug }, invitedEmail: row.invitedEmail, role: row.roleName, expiresAt: row.expiresAt };
}

export async function accept({ token, name, password }) {
  if (typeof password !== 'string' || password.length < 8) throw ApiError.badRequest('Password must be at least 8 characters');
  const tokenHash = digest(String(token ?? ''));
  const pending = await invitationRepository.findLiveByHash(tokenHash);
  if (!pending) throw ApiError.badRequest(INVALID);
  // Only a still-invited account can be activated by an invitation; check
  // before consuming so a refused attempt does not burn the token.
  const user = await userRepository.findByEmail(pending.tenantId, pending.invitedEmail);
  if (!user || user.status !== 'invited') throw ApiError.badRequest(INVALID);
  const passwordHash = await hashPassword(password);
  const consumed = await invitationRepository.consume({ id: pending._id, acceptedBy: pending.invitedEmail });
  if (!consumed) throw ApiError.badRequest(INVALID);
  const updated = await userRepository.update(user._id, { passwordHash, status: 'active', 'profile.name': String(name ?? '').trim(), acceptedAt: new Date(), failedAttempts: 0, lockedUntil: null });
  if (!updated) throw ApiError.badRequest(INVALID);
  await auditEmit({ actor: { type: 'user', id: String(user._id) }, action: 'tenant.invitation_accepted', module: 'iam.tenant_invitations', resource: { type: 'invitation', id: pending._id }, tenantId: pending.tenantId, after: { userId: String(user._id) } });
  return { ok: true, tenantId: pending.tenantId, email: pending.invitedEmail };
}

/** Paginated invitation history of one tenant (any status). */
export const list = ({ tenantId, status, page, limit }) => invitationRepository.list({ tenantId, status, page, limit });

/**
 * Revoke a pending invitation. Drops the invitee's provisional role grant
 * and gives the seat back. A tenant user must hold the invited role's
 * permissions (ceiling).
 */
export const revoke = async ({ id, tenantId, by, actorType = 'admin' }) => {
  const existing = await findTenantInvitation({ id, tenantId });
  if (existing.status !== 'pending') throw ApiError.conflict('Invitation is no longer pending');
  if (actorType === 'user') {
    const role = await roleRepository.findById(existing.roleId).catch(() => null);
    if (role) await assertInviterMayGrant({ tenantId, role, invitedBy: by, actorType, verb: 'revoke an invitation for' });
  }
  const result = await invitationRepository.revoke(existing._id, by);
  if (!result) throw ApiError.conflict('Invitation is no longer pending');
  // Revoking must actually remove access: drop the provisional role grant of
  // an invitee who never activated, and give the seat back.
  const released = await releaseInvitee({ tenantId: existing.tenantId, invitedEmail: existing.invitedEmail, by });
  await auditEmit({
    actor: { type: actorType === 'user' ? 'user' : 'admin', id: String(by ?? 'unknown') },
    action: 'tenant.invitation_revoked',
    module: 'iam.tenant_invitations',
    resource: { type: 'invitation', id: String(existing._id) },
    tenantId: String(existing.tenantId),
    before: { status: existing.status },
    after: { status: 'revoked', invitedEmail: existing.invitedEmail, role: existing.roleName, seatReleased: released },
  });
  return safeInvitation(result);
};

/**
 * Resend an invitation.
 *
 * - pending: a new link replaces the old one on the same invitation (the old
 *   link stops working), the expiry restarts and the seat is kept;
 * - expired: a new invitation is created for the same email and role (it
 *   takes a seat again, since the sweep gave the old one back);
 * - accepted / revoked: 409.
 * Called with `email` instead of `invitationId`, the pending invitation of
 * that address is resent, or a new one is created when none is pending.
 *
 * @returns {Promise<{ invitation: Object, delivered: boolean }>}
 */
export const resend = async ({ tenantId, invitationId, email, name = '', roleName = 'Owner', invitedBy, actorType = 'admin' }) => {
  let existing = null;
  if (invitationId) {
    existing = await findTenantInvitation({ id: invitationId, tenantId });
  } else if (email) {
    existing = await invitationRepository.findPendingByEmail({ tenantId, invitedEmail: String(email).trim().toLowerCase() });
    if (!existing) return create({ tenantId, email, name, roleName, invitedBy, actorType });
  } else {
    throw ApiError.badRequest('invitationId or email is required');
  }

  const user = await userRepository.findByEmail(String(tenantId), existing.invitedEmail);
  if (existing.status === 'expired') {
    return create({
      tenantId, email: existing.invitedEmail, name: user?.profile?.name ?? '', roleName: existing.roleName, invitedBy, actorType,
    });
  }
  if (existing.status !== 'pending') throw ApiError.conflict('Only pending or expired invitations can be resent');
  if (user && user.status !== 'invited') throw ApiError.conflict('This person has already joined the workspace');

  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');
  const role = (await roleRepository.findById(existing.roleId).catch(() => null))
    ?? (await resolveRole(tenantId, existing.roleName));
  await assertInviterMayGrant({ tenantId, role, invitedBy, actorType, verb: 'resend an invitation for' });

  const rawToken = randomBytes(32).toString('base64url');
  const now = new Date();
  const rotated = await invitationRepository.rotateToken({
    id: existing._id, tenantId, tokenHash: digest(rawToken), expiresAt: new Date(now.getTime() + invitationTtlMs()), now,
  });
  if (!rotated) throw ApiError.conflict('Invitation is no longer pending');
  const sent = await sendInvitationEmail({ tenantId, invitationId: existing._id, to: existing.invitedEmail, tenantName: tenant.name, rawToken });
  const invitation = safeInvitation(rotated);
  if (!sent.delivered) invitation.deliveryError = sent.error;
  await auditEmit({
    actor: { type: actorType === 'user' ? 'user' : 'admin', id: String(invitedBy ?? 'unknown') },
    action: 'tenant.invitation_resent',
    module: 'iam.tenant_invitations',
    resource: { type: 'invitation', id: String(existing._id) },
    tenantId: String(tenantId),
    after: { invitedEmail: existing.invitedEmail, role: existing.roleName, resendCount: rotated.resendCount, delivered: sent.delivered },
  });
  return { invitation, delivered: sent.delivered };
};

/**
 * Expiry sweep: move pending invitations past their `expiresAt` to
 * `expired`, drop each invitee's provisional grant and give the seat back.
 * Idempotent and safe to overlap with accept/resend/revoke (each row is
 * transitioned by a conditional update).
 *
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @param {number} [opts.limit=500]
 * @returns {Promise<{ scanned: number, expired: number, seatsReleased: number }>}
 */
export async function expireDue({ now = new Date(), limit = 500 } = {}) {
  const due = await invitationRepository.listDueForExpiry({ now, limit });
  let expired = 0;
  let seatsReleased = 0;
  for (const row of due) {
    const marked = await invitationRepository.markExpired({ id: row._id, now });
    if (!marked) continue;
    expired += 1;
    try {
      if (await releaseInvitee({ tenantId: row.tenantId, invitedEmail: row.invitedEmail, by: 'system' })) seatsReleased += 1;
      await auditEmit({
        actor: { type: 'system', id: 'invitation-expiry' },
        action: 'tenant.invitation_expired',
        module: 'iam.tenant_invitations',
        resource: { type: 'invitation', id: String(row._id) },
        tenantId: String(row.tenantId),
        after: { status: 'expired', invitedEmail: row.invitedEmail, role: row.roleName },
      });
    } catch (err) {
      // The row is already `expired`; reconciliation corrects a missed seat.
      logger.warn({ err: { message: err?.message }, invitationId: String(row._id) }, 'invitation expiry follow-up failed');
    }
  }
  return { scanned: due.length, expired, seatsReleased };
}

export default {
  create, preview, accept, list, revoke, resend, expireDue, invitationTtlMs,
  _meta: { token: 'opaque-single-use-sha256' },
};
