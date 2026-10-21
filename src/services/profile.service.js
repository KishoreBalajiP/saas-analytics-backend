/**
 * Profile Service (onboarding, roadmap 3.6).
 *
 * PURPOSE
 *   Self-service security for the signed-in tenant user: password change
 *   (requires the current password), and the user's own active sessions
 *   (list + revoke). Every operation is scoped to the caller's user id AND
 *   tenant; a session id of another user is a 404.
 */

import ApiError from '../utils/ApiError.js';
import { hash as hashPassword, verify as verifyPassword } from '../utils/password.js';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import * as sessionService from '../modules/iam/auth/session.service.js';
import { securityEvent } from './securityEvent.service.js';

const MIN_PASSWORD = 8;

function fieldError(field, message, status = 400) {
  return new ApiError(status, message, { code: 'VALIDATION_ERROR', errors: [{ field, message }] });
}

/**
 * Change the caller's password. The current password is required; other
 * sessions are revoked (the current one stays signed in).
 */
export async function changePassword({ userId, tenantId, sessionId = null, currentPassword, newPassword } = {}) {
  if (typeof currentPassword !== 'string' || !currentPassword) throw fieldError('currentPassword', 'Current password is required');
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) {
    throw fieldError('newPassword', `New password must be at least ${MIN_PASSWORD} characters`);
  }
  const user = await User.findOne({ _id: userId, tenantId, deletedAt: null }).select('passwordHash email status').lean();
  if (!user || user.status !== 'active') throw ApiError.notFound('User not found');
  const ok = user.passwordHash ? await verifyPassword(currentPassword, user.passwordHash).catch(() => false) : false;
  if (!ok) throw fieldError('currentPassword', 'Current password is incorrect');
  if (await verifyPassword(newPassword, user.passwordHash).catch(() => false)) {
    throw fieldError('newPassword', 'New password must differ from the current one');
  }
  await User.updateOne({ _id: userId, tenantId }, { $set: { passwordHash: await hashPassword(newPassword) } });
  const others = await Session.find({ actorId: String(userId), actorType: 'user', tenantId, status: 'active', sessionId: { $ne: sessionId } })
    .select('sessionId').lean();
  for (const s of others) await sessionService.revoke({ sessionId: s.sessionId, reason: 'password_changed' });
  await securityEvent('PASSWORD_CHANGED', {
    actor: { type: 'user', id: String(userId), display: user.email ?? null },
    tenantId,
    resource: { type: 'user', id: String(userId) },
    metadata: { sessionsRevoked: others.length },
  });
  return { ok: true, sessionsRevoked: others.length };
}

/** The caller's active sessions (no token material). */
export async function listSessions({ userId, tenantId, currentSessionId = null } = {}) {
  const rows = await Session.find({ actorId: String(userId), actorType: 'user', tenantId, status: 'active', expiresAt: { $gt: new Date() } })
    .select('sessionId device ip userAgent issuedAt lastUsedAt authenticatedAt impersonatedBy')
    .sort({ lastUsedAt: -1 })
    .limit(100)
    .lean();
  return rows.map((s) => ({
    sessionId: s.sessionId,
    current: s.sessionId === currentSessionId,
    device: s.device?.name || s.device?.browser || null,
    ip: s.ip || null,
    userAgent: s.userAgent || null,
    signedInAt: s.authenticatedAt ?? s.issuedAt ?? null,
    lastUsedAt: s.lastUsedAt ?? null,
    impersonated: Boolean(s.impersonatedBy),
  }));
}

/** Revoke one of the caller's own sessions. */
export async function revokeSession({ userId, tenantId, sessionId } = {}) {
  const session = await Session.findOne({ sessionId: String(sessionId ?? ''), actorId: String(userId), actorType: 'user', tenantId, status: 'active' })
    .select('sessionId').lean();
  if (!session) throw ApiError.notFound('Session not found');
  await sessionService.revoke({ sessionId: session.sessionId, reason: 'user_revoked' });
  return true;
}

export default { changePassword, listSessions, revokeSession };
