/**
 * Password Service (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Forgot/reset password for BOTH portals. The reset credential is a
 *   short-lived, signed JWT (stateless), so no extra collection is needed:
 *   the token carries `{ purpose: 'password_reset', sub }`, is scoped to the
 *   portal audience, and expires after `security.auth.passwordResetTokenTtlMs`.
 *
 * RESPONSIBILITY (business rules ONLY - no raw database access)
 *   - requestReset({ portal, email, tenantId? }) -> always returns OK (no
 *     user enumeration); emails a reset link when an account exists.
 *   - resetPassword({ portal, token, newPassword, tenantId? }) -> verify the
 *     token, set the new Argon2id hash, clear lockout, revoke all sessions.
 *
 * SECURITY RULES
 *   - The reset token is delivered ONLY by email - it is never returned in
 *     an API response.
 *   - Unknown emails, expired/invalid tokens, suspended accounts and reused
 *     tokens all produce the same generic error message (no enumeration).
 *   - A password change revokes the ENTIRE session family, so an old stolen
 *     refresh token dies the moment the password rotates.
 */

import env from '../../../config/env.js';
import ApiError from '../../../utils/ApiError.js';
import { createChildLogger } from '../../../utils/logger.js';
import { hash as hashPassword } from '../../../utils/password.js';
import { sign as signJwt, verify as verifyJwt, JWT_AUDIENCES } from '../../../utils/jwt.js';
import emailService from '../../../services/email.service.js';
import userRepository from '../../../repositories/user.repository.js';
import adminRepository from '../../../repositories/admin.repository.js';
import sessionService from './session.service.js';

const logger = createChildLogger({ module: 'services/password' });
const AUTH = env.security.auth;

/** Portal -> account resolver + JWT audience. */
const PORTAL = Object.freeze({
  user: {
    audience: JWT_AUDIENCES.USER,
    findAccount: (email, tenantId) => userRepository.findByEmail(tenantId, email),
    updatePassword: (id, passwordHash) => userRepository.update(id, { passwordHash }),
    clearLockout: (id) => userRepository.resetFailedAttempts(id),
    findById: (id) => userRepository.findById(id),
  },
  admin: {
    audience: JWT_AUDIENCES.ADMIN,
    findAccount: (email) => adminRepository.findByEmail(email),
    updatePassword: (id, passwordHash) => adminRepository.update(id, { passwordHash }),
    clearLockout: (id) => adminRepository.resetFailedAttempts(id),
    findById: (id) => adminRepository.findById(id),
  },
});

/**
 * Request a password reset. Never reveals whether an account exists: it
 * emails a reset link only when the account is found and not suspended, and
 * swallows email failures so attackers cannot probe the delivery either.
 *
 * @param {Object} params
 * @param {'user'|'admin'} params.portal
 * @param {string} params.email
 * @param {string|null} [params.tenantId] - required for the user portal.
 * @returns {Promise<{ ok: boolean }>} always `{ ok: true }`.
 */
export async function requestReset({ portal, email, tenantId = null }) {
  const cfg = PORTAL[portal];
  if (!cfg) throw ApiError.badRequest('Unknown portal');
  if (portal === 'user' && !tenantId) throw ApiError.badRequest('Tenant id is required');
  const normalized = String(email ?? '').toLowerCase().trim();
  if (!normalized) throw ApiError.badRequest('Email is required');

  const account = await cfg.findAccount(normalized, tenantId);
  if (account && account.status !== 'suspended') {
    const token = await signJwt({
      payload: { purpose: 'password_reset', email: normalized },
      subject: String(account._id),
      audience: cfg.audience,
      expiresIn: Math.floor(AUTH.passwordResetTokenTtlMs / 1000),
    });
    const resetUrl = `${env.cors.clientUrl}/reset-password?token=${encodeURIComponent(token)}`;
    try {
      await emailService.send({
        to: normalized,
        subject: 'Reset your password',
        text: [
          `A password reset was requested for ${normalized}.`,
          'Use this link to choose a new password:',
          '',
          resetUrl,
          '',
          'This link expires within 15 minutes.',
          'If you did not request a reset, you can safely ignore this email.',
        ].join('\n'),
      });
      logger.info({ portal, actorId: String(account._id) }, 'password reset email sent');
    } catch (err) {
      logger.error({ err: { message: err?.message } }, 'password reset email delivery failed');
    }
  }
  return { ok: true };
}

/**
 * Complete a password reset: verify the stateless token, persist the new
 * Argon2id hash, clear lockout counters and revoke every session the actor
 * owns. Any invalid state maps to one generic error (no enumeration).
 *
 * @param {Object} params
 * @param {'user'|'admin'} params.portal
 * @param {string} params.token - signed JWT from the reset email.
 * @param {string} params.newPassword
 * @param {string|null} [params.tenantId] - required for the user portal.
 * @returns {Promise<{ ok: boolean }>}
 */
export async function resetPassword({ portal, token, newPassword, tenantId = null }) {
  const cfg = PORTAL[portal];
  if (!cfg) throw ApiError.badRequest('Unknown portal');
  if (portal === 'user' && !tenantId) throw ApiError.badRequest('Tenant id is required');
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw ApiError.badRequest('New password must be at least 8 characters');
  }

  let payload;
  try {
    const result = await verifyJwt({ token, audience: cfg.audience });
    payload = result.payload;
  } catch {
    throw ApiError.badRequest('Password reset link is invalid or has expired');
  }
  if (payload.purpose !== 'password_reset' || !payload.sub) {
    throw ApiError.badRequest('Password reset link is invalid or has expired');
  }

  const account = await cfg.findById(payload.sub);
  if (!account || account.status === 'suspended') {
    throw ApiError.badRequest('Password reset link is invalid or has expired');
  }

  const newHash = await hashPassword(newPassword);
  await cfg.updatePassword(account._id, newHash);
  await cfg.clearLockout(account._id);
  await sessionService.revokeAllForActor({ actorId: String(account._id), reason: 'password_reset' });

  logger.info({ portal, actorId: String(account._id) }, 'password reset completed');
  return { ok: true };
}

export default {
  requestReset,
  resetPassword,
  _meta: { token: 'stateless-jwt', delivery: 'email-only', revokesSessions: true },
};
