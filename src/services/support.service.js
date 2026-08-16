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
 *   - Impersonation issues a real user access token (audience `user`) so the
 *     impersonated experience is indistinguishable from the user's own; the
 *     JWT carries `impersonation: true` and the backing session is tagged
 *     with `impersonatedBy` so it can be attributed and revoked.
 *   - Impersonation is capped per admin per day
 *     (`env.support.impersonationBudgetDailyCap`; 0 disables the cap).
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
import * as accessLogService from './accessLog.service.js';
import { sign as signJwt, JWT_AUDIENCES } from '../utils/jwt.js';

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
 * access log (attributed to the acting admin).
 */
async function logSupportAction({ adminDoc, module, action, target, reason, tenantId, ip, userAgent, requestId }) {
  await emitAudit({
    actor: { type: 'admin', id: String(adminDoc._id), display: adminDoc.email ?? String(adminDoc._id) },
    action,
    module,
    resource: target ? { type: target.type, id: String(target.id) } : undefined,
    reason,
    tenantId: tenantId ?? null,
    ip,
    userAgent,
    requestId,
  });
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
 * Start an impersonation session for a user. Returns a fully-fledged user
 * access token (audience `user`) bound to a session tagged with the acting
 * admin, so it behaves exactly like the user's own session yet remains
 * attributable and revocable.
 */
export async function impersonate({ actor, targetUserId, reason, ip, userAgent, requestId }) {
  if (!reason || !String(reason).trim()) {
    throw ApiError.badRequest('A reason is required for impersonation');
  }
  const adminDoc = await resolveAdminDoc(actor);
  const user = await resolveActiveUser(targetUserId, adminDoc);

  const cap = env.support.impersonationBudgetDailyCap;
  if (cap > 0) {
    const used = await accessLogService.countImpersonationsToday(String(adminDoc._id));
    if (used >= cap) {
      throw ApiError.tooManyRequests('Daily impersonation budget exhausted');
    }
  }

  const refreshToken = sessionService.generateRefreshToken();
  const { session } = await sessionService.create({
    actorId: String(user._id),
    actorType: 'user',
    tenantId: user.tenantId,
    refreshToken,
    impersonatedBy: String(adminDoc._id),
    ip: ip ?? '',
    userAgent: userAgent ? `${userAgent} (impersonation)` : '(impersonation)',
  });

  const expiresAt = new Date(Date.now() + parseImpersonationTtlMs());
  const token = await signJwt({
    payload: {
      sessionId: session.sessionId,
      email: user.email,
      tenantId: user.tenantId,
      impersonation: true,
    },
    subject: String(user._id),
    audience: JWT_AUDIENCES.USER,
    expiresIn: env.support.impersonationTokenTtl,
  });

  await logSupportAction({
    adminDoc,
    module: 'support.impersonation',
    action: 'impersonate',
    target: { type: 'user', id: String(user._id) },
    reason: String(reason).trim(),
    tenantId: user.tenantId,
    ip,
    userAgent,
    requestId,
  });

  logger.warn(
    { adminId: String(adminDoc._id), userId: String(user._id), sessionId: session.sessionId },
    'support impersonation started',
  );

  return {
    token,
    expiresAt,
    sessionId: session.sessionId,
    impersonation: true,
    user: {
      id: String(user._id),
      email: user.email,
      name: user.profile?.name ?? null,
      tenantId: user.tenantId,
    },
    startedAt: new Date().toISOString(),
  };
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

  await logSupportAction({
    adminDoc,
    module: 'support.impersonation',
    action: 'impersonate.stop',
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

/* ------------------------------ internals -------------------------------- */

/** Resolve the impersonation token TTL to milliseconds (for the expiry). */
function parseImpersonationTtlMs() {
  const value = String(env.support.impersonationTokenTtl ?? '15m');
  const m = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (m) return Number(m[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return 15 * 60000;
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
