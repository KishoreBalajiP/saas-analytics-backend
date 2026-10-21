/**
 * Support Service (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Admin-only support tooling: secure impersonation into a user session,
 *   account recovery on behalf of a user, session revocation, tenant
 *   lookups, and tenant-scoped broadcasts.
 *
 * RESPONSIBILITY
 *   - impersonate / stopImpersonation  (audited twice, daily-capped)
 *   - recoverAccount / revokeAllSessions
 *   - getTenantLookups / broadcastNotification
 *
 * SECURITY MODEL
 *   - Every action requires an explicit `reason` (≤ 500 chars).
 *   - Every action is recorded in BOTH the audit trail and the access log.
 *   - Tenant-scoped support admins are hard-bound to their tenant: the scope
 *     is re-read from the DB (not the JWT), and any cross-tenant target is a
 *     403.
 *   - Impersonation issues a user access token (audience `user`) for a
 *     READ-ONLY support session (roadmap 2.3): the JWT carries
 *     `impersonation: true`, the backing session is tagged with
 *     `impersonatedBy`, and the auth middleware refuses every unsafe method
 *     for it (403 IMPERSONATION_READ_ONLY) and attributes every request to
 *     the operator.
 *   - Impersonation needs the workspace's consent (an active `consent`
 *     grant) or the operator's own approved break-glass grant
 *     (`supportAccess.service.js`), an active workspace, and a target that
 *     is not platform staff.
 *   - Support sessions are time-boxed: the session ends with its token
 *     (`SUPPORT_IMPERSONATION_TOKEN_TTL`, at most 60 minutes, never past the
 *     grant) and never refreshes (the refresh token is never handed out).
 *   - Impersonation is capped per admin per day with one atomic counter
 *     increment (`env.support.impersonationBudgetDailyCap`; 0 disables it).
 *   - `recoverAccount` never emails a suspended account (same invariant as
 *     the password service) - the support admin must restore the account
 *     first.
 */

import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import userRepository from '../repositories/user.repository.js';
import tenantRepository from '../repositories/tenant.repository.js';
import adminRepository from '../repositories/admin.repository.js';
import sessionRepository from '../repositories/session.repository.js';
import notificationRepository from '../repositories/notification.repository.js';
import sessionService from '../modules/iam/auth/session.service.js';
import * as passwordService from '../modules/iam/auth/password.service.js';
import * as tenantStatisticsService from './tenantStatistics.service.js';
import { emit as emitAudit } from './auditLog.service.js';
import { securityEvent } from './securityEvent.service.js';
import * as accessLogService from './accessLog.service.js';
import { sign as signJwt, JWT_AUDIENCES, parseExpiresIn } from '../utils/jwt.js';
// support: consent / break-glass gate, atomic daily cap and session records.
import * as supportAccessService from './supportAccess.service.js';
import { IMPERSONATION_MAX_TTL_SECONDS } from '../constants/support.js';

/** Cap on broadcast fan-out per request (safety valve, not a policy knob). */
const MAX_BROADCAST_RECIPIENTS = 500;

/* ------------------------------ internals -------------------------------- */

/**
 * Re-read the acting admin from the DB so scope enforcement uses the
 * persisted role, never a (potentially stale) JWT claim.
 */
async function resolveAdminDoc(actor) {
  const doc = await adminRepository.findById(actor?.id);
  if (!doc) throw ApiError.forbidden('Admin no longer exists');
  return doc;
}

/** Platform admins can act anywhere; scoped admins only inside their tenant. */
function assertInScope(adminDoc, tenantId) {
  if (adminDoc.tenantScope && tenantId !== adminDoc.tenantScope) {
    throw ApiError.forbidden('Target is outside your tenant scope');
  }
}

/** Resolve a live (non-suspended) user for support actions. */
async function resolveActiveUser(userId, adminDoc) {
  const user = await userRepository.findById(userId);
  if (!user || user.deletedAt) throw ApiError.notFound('User not found');
  assertInScope(adminDoc, user.tenantId);
  if (user.status === 'suspended') {
    throw ApiError.conflict('User is suspended; support actions are blocked');
  }
  return user;
}

/**
 * Record a support action twice: once on the audit trail (scoped to the
 * target user's tenant so the customer sees their own row) and once on the
 * access log (attributed to the acting admin). Impersonation start/stop are
 * security events (`security` = a key of `constants/securityEvents.js`):
 * same module/action as before, plus `category: 'security'` and severity.
 */
async function logSupportAction({ adminDoc, module, action, target, reason, tenantId, ip, userAgent, requestId, security = null, metadata = null, after = null }) {
  const entry = {
    actor: { type: 'admin', id: String(adminDoc._id), display: adminDoc.email ?? String(adminDoc._id) },
    resource: target ? { type: target.type, id: String(target.id) } : undefined,
    reason,
    tenantId: tenantId ?? null,
    metadata,
    ip,
    userAgent,
    requestId,
  };
  if (security) {
    // support: session facts (grant, break-glass flag, expiry) ride in the
    // event metadata so the security trail carries them too.
    await securityEvent(security, after ? { ...entry, metadata: { ...(metadata ?? {}), ...after } } : entry);
  } else {
    await emitAudit({ ...entry, action, module, ...(after ? { after } : {}) });
  }
  accessLogService.capture({
    actorType: 'admin',
    actorId: String(adminDoc._id),
    tenantId: adminDoc.tenantScope ?? null,
    method: 'POST',
    path: `/support/${action}`,
    statusCode: 200,
    event: action,
    ip,
    userAgent,
    requestId,
    error: null,
  });
}

/* ------------------------------- actions --------------------------------- */

/**
 * Start a READ-ONLY support session as a user (roadmap 2.3). Requires the
 * workspace's consent or the operator's own approved break-glass grant,
 * takes one slot of the operator's daily budget atomically, and returns a
 * user-audience access token whose backing session ends with the token
 * (no refresh). Every request made with it is attributed to the operator.
 */
export async function impersonate({ actor, targetUserId, reason, ticket = null, ip, userAgent, requestId }) {
  if (!reason || !String(reason).trim()) {
    throw ApiError.badRequest('A reason is required for impersonation');
  }
  const adminDoc = await resolveAdminDoc(actor);
  const user = await resolveActiveUser(targetUserId, adminDoc);

  // support: workspace active, target not platform staff, usable grant.
  const { grant } = await supportAccessService.authorizeImpersonation({ adminDoc, user, ip, userAgent, requestId });
  // support: one conditional $inc - concurrent starts cannot pass the cap.
  await supportAccessService.reserveImpersonationSlot({ adminId: String(adminDoc._id) });

  let opened;
  try {
    opened = await openSupportSession({ adminDoc, user, grant, reason, ticket, ip, userAgent });
  } catch (err) {
    await supportAccessService.releaseImpersonationSlot({ adminId: String(adminDoc._id) });
    throw err;
  }
  const { session, token, expiresAt, startedAt } = opened;

  await logSupportAction({
    adminDoc,
    module: 'support.impersonation',
    action: 'impersonate',
    security: 'SUPPORT_IMPERSONATION_STARTED',
    target: { type: 'user', id: String(user._id) },
    reason: String(reason).trim(),
    tenantId: user.tenantId,
    metadata: { sessionId: session.sessionId, targetUserId: String(user._id), expiresAt },
    ip,
    userAgent,
    requestId,
    after: {
      sessionId: session.sessionId,
      grantId: grant.grantId,
      kind: grant.kind,
      breakGlass: grant.kind === 'break_glass',
      readOnly: true,
      expiresAt,
      ticket: ticket ? String(ticket).trim().slice(0, 120) : null,
    },
  });

  logger.warn(
    { adminId: String(adminDoc._id), userId: String(user._id), sessionId: session.sessionId, breakGlass: grant.kind === 'break_glass' },
    'support impersonation started',
  );

  return {
    token,
    expiresAt,
    expiresIn: Math.max(0, Math.round((expiresAt.getTime() - startedAt.getTime()) / 1000)),
    sessionId: session.sessionId,
    impersonation: true,
    readOnly: true,
    breakGlass: grant.kind === 'break_glass',
    grantId: grant.grantId,
    user: {
      id: String(user._id),
      email: user.email,
      name: user.profile?.name ?? null,
      tenantId: user.tenantId,
    },
    startedAt: startedAt.toISOString(),
  };
}

/**
 * support: the effective lifetime of a support session in seconds - the
 * configured token TTL, capped at IMPERSONATION_MAX_TTL_SECONDS.
 */
export function impersonationTtlSeconds() {
  let configured;
  try {
    configured = parseExpiresIn(env.support.impersonationTokenTtl ?? '15m');
  } catch {
    configured = 15 * 60;
  }
  return Math.max(60, Math.min(configured, IMPERSONATION_MAX_TTL_SECONDS));
}

/**
 * support: create the backing session (expiring with the token, its refresh
 * token never handed out), sign the token, and persist the workspace-visible
 * record. A failure after the session exists revokes it again.
 */
async function openSupportSession({ adminDoc, user, grant, reason, ticket, ip, userAgent }) {
  const startedAt = new Date();
  let expiresAt = new Date(startedAt.getTime() + impersonationTtlSeconds() * 1000);
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() < expiresAt.getTime()) {
    expiresAt = new Date(grant.expiresAt);
  }
  const ttlSeconds = Math.max(1, Math.floor((expiresAt.getTime() - startedAt.getTime()) / 1000));
  expiresAt = new Date(startedAt.getTime() + ttlSeconds * 1000);

  const { session } = await sessionService.create({
    actorId: String(user._id),
    actorType: 'user',
    tenantId: user.tenantId,
    // Required by the session model; never returned, so the session cannot
    // be refreshed (and rotate() refuses support sessions anyway).
    refreshToken: sessionService.generateRefreshToken(),
    impersonatedBy: String(adminDoc._id),
    ip: ip ?? '',
    userAgent: userAgent ? `${userAgent} (impersonation)` : '(impersonation)',
    expiresAt,
  });

  try {
    const token = await signJwt({
      payload: {
        sessionId: session.sessionId,
        email: user.email,
        tenantId: user.tenantId,
        impersonation: true,
        readOnly: true,
      },
      subject: String(user._id),
      audience: JWT_AUDIENCES.USER,
      expiresIn: ttlSeconds,
    });
    await supportAccessService.recordImpersonationStart({
      sessionId: session.sessionId,
      user,
      adminDoc,
      grant,
      reason,
      ticket,
      startedAt,
      expiresAt,
    });
    return { session, token, expiresAt, startedAt };
  } catch (err) {
    await sessionRepository.revoke(session.sessionId, 'impersonation_failed').catch(() => null);
    throw err;
  }
}

/**
 * Revoke an impersonation session. Only the admin who started it may stop it.
 */
export async function stopImpersonation({ actor, sessionId, reason, ip, userAgent, requestId }) {
  if (!reason || !String(reason).trim()) {
    throw ApiError.badRequest('A reason is required to stop impersonation');
  }
  const adminDoc = await resolveAdminDoc(actor);
  const session = await sessionRepository.findById(sessionId);
  if (!session) throw ApiError.notFound('Session not found');
  if (session.impersonatedBy !== String(adminDoc._id)) {
    throw ApiError.forbidden('You did not start this impersonation');
  }

  await sessionRepository.revoke(sessionId, 'impersonation_stopped');
  // support: close the workspace-visible record of the session.
  await supportAccessService.recordImpersonationEnd({
    sessionId,
    endedBy: String(adminDoc._id),
    reason: String(reason).trim(),
  });

  await logSupportAction({
    adminDoc,
    module: 'support.impersonation',
    action: 'impersonate.stop',
    security: 'SUPPORT_IMPERSONATION_STOPPED',
    metadata: { sessionId, targetUserId: session.actorId ? String(session.actorId) : null },
    target: { type: 'session', id: sessionId },
    reason: String(reason).trim(),
    tenantId: session.tenantId ?? null,
    ip,
    userAgent,
    requestId,
  });

  return { sessionId, status: 'revoked', stoppedAt: new Date().toISOString() };
}

/**
 * Admin-initiated account recovery: unlock the account and issue a password
 * reset by email. Mirrors the password service invariant - suspended
 * accounts are never emailed.
 */
export async function recoverAccount({ actor, userId, reason, ip, userAgent, requestId }) {
  if (!reason || !String(reason).trim()) {
    throw ApiError.badRequest('A reason is required for account recovery');
  }
  const adminDoc = await resolveAdminDoc(actor);
  const user = await resolveActiveUser(userId, adminDoc);

  await userRepository.resetFailedAttempts(String(user._id));
  await passwordService.requestReset({
    portal: 'user',
    email: user.email,
    tenantId: user.tenantId,
  });

  await logSupportAction({
    adminDoc,
    module: 'support.account.recover',
    action: 'account.recover',
    target: { type: 'user', id: String(user._id) },
    reason: String(reason).trim(),
    tenantId: user.tenantId,
    ip,
    userAgent,
    requestId,
  });

  return {
    userId: String(user._id),
    ok: true,
    method: 'password_reset_email',
    resetRequested: true,
  };
}

/** Revoke every active session owned by a user (lock their devices out). */
export async function revokeAllSessions({ actor, userId, reason, ip, userAgent, requestId }) {
  if (!reason || !String(reason).trim()) {
    throw ApiError.badRequest('A reason is required to revoke sessions');
  }
  const adminDoc = await resolveAdminDoc(actor);
  const user = await resolveActiveUser(userId, adminDoc);

  const revokedCount = await sessionService.revokeAllForActor({
    actorId: String(user._id),
    reason: 'support_revoked',
    tenantId: String(user.tenantId),
  });

  await logSupportAction({
    adminDoc,
    module: 'support.account.revoke-sessions',
    action: 'session.revoke_all',
    target: { type: 'user', id: String(user._id) },
    reason: String(reason).trim(),
    tenantId: user.tenantId,
    ip,
    userAgent,
    requestId,
  });

  return { userId: String(user._id), revokedCount, status: 'completed' };
}

/** Tenant overview for a support admin: tenant + live usage statistics. */
export async function getTenantLookups({ actor, tenantId, ip, userAgent, requestId }) {
  const adminDoc = await resolveAdminDoc(actor);
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant || tenant.deletedAt) throw ApiError.notFound('Tenant not found');
  assertInScope(adminDoc, String(tenant._id));

  const statistics = await tenantStatisticsService.getStatistics({ tenantId: String(tenant._id) });

  await logSupportAction({
    adminDoc,
    module: 'support.tenants.lookups',
    action: 'tenant.lookup',
    target: { type: 'tenant', id: String(tenant._id) },
    reason: null,
    tenantId: String(tenant._id),
    ip,
    userAgent,
    requestId,
  });

  return { tenant, statistics };
}

/** Tenant-scoped in-app broadcast. Deliberately capped per call. */
export async function broadcastNotification({ actor, tenantId, title, body, type = 'announcement', reason, ip, userAgent, requestId }) {
  if (!reason || !String(reason).trim()) {
    throw ApiError.badRequest('A reason is required for a broadcast');
  }
  if (!title || !String(title).trim()) {
    throw ApiError.badRequest('A broadcast title is required');
  }
  const adminDoc = await resolveAdminDoc(actor);
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant || tenant.deletedAt) throw ApiError.notFound('Tenant not found');
  assertInScope(adminDoc, String(tenant._id));

  const { docs: users } = await userRepository.list({
    tenantId: String(tenant._id),
    filter: { status: 'active' },
    page: 1,
    limit: MAX_BROADCAST_RECIPIENTS,
  });

  const now = new Date();
  const docs = users.map((u) => ({
    recipientId: String(u._id),
    tenantId: String(tenant._id),
    channel: 'in_app',
    type,
    title: String(title).trim().slice(0, 120),
    body: body ? String(body).trim().slice(0, 2000) : '',
    data: { broadcast: true, by: String(adminDoc._id) },
    read: false,
    createdAt: now,
  }));
  const recipientCount = await notificationRepository.createMany(docs);

  await logSupportAction({
    adminDoc,
    module: 'support.notifications.broadcast',
    action: 'notification.broadcast',
    target: { type: 'tenant', id: String(tenant._id) },
    reason: String(reason).trim(),
    tenantId: String(tenant._id),
    ip,
    userAgent,
    requestId,
  });

  return {
    targetTenantId: String(tenant._id),
    recipientCount,
    capped: recipientCount >= MAX_BROADCAST_RECIPIENTS,
    status: 'completed',
  };
}

export default {
  impersonate,
  stopImpersonation,
  recoverAccount,
  revokeAllSessions,
  getTenantLookups,
  broadcastNotification,
  _meta: {
    phase: '8 - implemented',
    audited: true,
    accessLogged: true,
    reasonRequired: true,
    maxBroadcastRecipients: MAX_BROADCAST_RECIPIENTS,
  },
};
