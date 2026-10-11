/**
 * Password recovery for both portals.
 *
 * Reset credentials are opaque, random, time-limited tokens. Only a SHA-256
 * digest is stored, and the matching database row is atomically consumed so
 * a token cannot be reused.
 */

import { createHash, randomBytes } from 'node:crypto';
import env from '../../../config/env.js';
import ApiError from '../../../utils/ApiError.js';
import { createChildLogger } from '../../../utils/logger.js';
import { hash as hashPassword } from '../../../utils/password.js';
import emailService from '../../../services/email.service.js';
import userRepository from '../../../repositories/user.repository.js';
import adminRepository from '../../../repositories/admin.repository.js';
import tenantRepository from '../../../repositories/tenant.repository.js';
import passwordResetTokenRepository from '../../../repositories/passwordResetToken.repository.js';
import sessionService from './session.service.js';
import { PasswordResetToken } from '../../../models/PasswordResetToken.js';

const logger = createChildLogger({ module: 'services/password' });
const AUTH = env.security.auth;
const INVALID_RESET = 'Password reset link is invalid or has expired';

const PORTAL = Object.freeze({
  user: {
    findAccount: (email, tenantId) => userRepository.findByEmail(tenantId, email),
    updatePassword: (id, passwordHash) => userRepository.update(id, { passwordHash }),
    clearLockout: (id) => userRepository.resetFailedAttempts(id),
    findById: (id) => userRepository.findById(id),
  },
  admin: {
    findAccount: (email) => adminRepository.findByEmail(email),
    updatePassword: (id, passwordHash) => adminRepository.update(id, { passwordHash }),
    clearLockout: (id) => adminRepository.resetFailedAttempts(id),
    findById: (id) => adminRepository.findById(id),
  },
});

export async function requestReset({ portal, email, tenantId = null }) {
  const cfg = PORTAL[portal];
  if (!cfg) throw ApiError.badRequest('Unknown portal');
  if (portal === 'user' && !tenantId) throw ApiError.badRequest('Tenant id is required');

  const tenant = portal === 'user' ? await resolveTenantContext(tenantId) : null;
  // Unknown workspace slugs follow the same generic forgot-password response
  // as unknown email addresses; they must not become a tenant enumeration
  // oracle or a Mongoose CastError.
  if (portal === 'user' && !tenant) return { ok: true };
  const resolvedTenantId = tenant?.id ?? tenantId;
  const normalized = String(email ?? '').toLowerCase().trim();
  if (!normalized) throw ApiError.badRequest('Email is required');

  const account = await cfg.findAccount(normalized, resolvedTenantId);
  if (account && account.status !== 'suspended') {
    const token = randomBytes(32).toString('base64url');
    await passwordResetTokenRepository.create({
      portal,
      actorId: String(account._id),
      tenantId: portal === 'user' ? resolvedTenantId : null,
      tokenHash: digestToken(token),
      expiresAt: new Date(Date.now() + AUTH.passwordResetTokenTtlMs),
    });

    const resetUrl = portal === 'user'
      ? `${env.cors.clientUrl}/login/reset?token=${encodeURIComponent(token)}&tenant=${encodeURIComponent(tenant?.slug ?? tenantId)}`
      : `${env.cors.clientUrl}/reset-password?token=${encodeURIComponent(token)}`;
    try {
      await emailService.send({
        to: normalized,
        subject: 'Reset your password',
        text: [
          'A password reset was requested for this account.',
          'Use this link to choose a new password:',
          '',
          resetUrl,
          '',
          'This link expires within 15 minutes and can only be used once.',
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

export async function resetPassword({ portal, token, newPassword, tenantId = null }) {
  const cfg = PORTAL[portal];
  if (!cfg) throw ApiError.badRequest('Unknown portal');
  if (portal === 'user' && !tenantId) throw ApiError.badRequest('Tenant id is required');
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw ApiError.badRequest('New password must be at least 8 characters');
  }

  const tenant = portal === 'user' ? await resolveTenantContext(tenantId) : null;
  if (portal === 'user' && !tenant) throw ApiError.badRequest(INVALID_RESET);
  const resolvedTenantId = tenant?.id ?? tenantId;
  const tokenHash = digestToken(token);
  const tokenRow = await findAndConsumeToken({ portal, tokenHash, tenantId: resolvedTenantId });
  if (!tokenRow) throw ApiError.badRequest(INVALID_RESET);

  const account = await cfg.findById(tokenRow.actorId);
  if (!account || account.status === 'suspended' ||
      (portal === 'user' && String(account.tenantId) !== String(resolvedTenantId))) {
    throw ApiError.badRequest(INVALID_RESET);
  }

  const newHash = await hashPassword(newPassword);
  await cfg.updatePassword(account._id, newHash);
  await cfg.clearLockout(account._id);
  await sessionService.revokeAllForActor({ actorId: String(account._id), reason: 'password_reset' });

  logger.info({ portal, actorId: String(account._id) }, 'password reset completed');
  return { ok: true };
}

async function findAndConsumeToken({ portal, tokenHash, tenantId }) {
  if (!tokenHash) return null;
  const row = await PasswordResetToken.findOne({
    portal,
    tokenHash,
    tenantId: portal === 'user' ? tenantId : null,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).select('actorId').lean();
  if (!row) return null;
  return passwordResetTokenRepository.consume({
    portal,
    tokenHash,
    actorId: row.actorId,
    tenantId: portal === 'user' ? tenantId : null,
  });
}

async function resolveTenantContext(identifier) {
  const tenant = await tenantRepository.findByIdOrSlug(identifier);
  if (!tenant) return null;
  return { id: String(tenant._id), slug: tenant.slug };
}

function digestToken(token) {
  if (typeof token !== 'string' || token.length < 20) return '';
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export default {
  requestReset,
  resetPassword,
  _meta: { token: 'opaque-single-use-sha256', delivery: 'email-only', revokesSessions: true },
};
