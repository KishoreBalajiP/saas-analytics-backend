/**
 * Password recovery for both portals.
 *
 * Reset credentials are opaque, random, time-limited tokens. Only a SHA-256
 * digest is stored, and the matching database row is atomically consumed so
 * a token cannot be reused.
 *
 * Links (adminauth, roadmap 2.2 / auth.15):
 *   - tenant portal: `<CLIENT_URL>/login/reset?token=...&tenant=<slug>`
 *   - admin portal:  `<CLIENT_URL>/admin/reset-password?token=...` (the
 *     frontend page posts to `/admin-auth/password/reset`).
 *   Lifetime: `PASSWORD_RESET_TTL_MS` (default 1 hour); the email states the
 *   configured lifetime.
 *
 * `issueAdminAssistedReset` sends the same kind of link to an admin whose
 * password another super admin has reset (adminCredentials.service).
 *
 * Requests for an active account and completed resets are recorded as
 * security events (`auth.password_reset.requested` / `.completed`); the
 * token never is.
 */

import { createHash, randomBytes } from 'node:crypto';
import env from '../../../config/env.js';
import ApiError from '../../../utils/ApiError.js';
import { createChildLogger } from '../../../utils/logger.js';
import { hash as hashPassword } from '../../../utils/password.js';
import outboxService from '../../../services/outbox.service.js';
import userRepository from '../../../repositories/user.repository.js';
import adminRepository from '../../../repositories/admin.repository.js';
import tenantRepository from '../../../repositories/tenant.repository.js';
import passwordResetTokenRepository from '../../../repositories/passwordResetToken.repository.js';
import sessionService from './session.service.js';
import { PasswordResetToken } from '../../../models/PasswordResetToken.js';
import { securityEvent } from '../../../services/securityEvent.service.js';
import { getCurrentActor } from '../../../utils/actorContext.js';
import { describeDuration } from '../../../utils/humanDuration.js';

const logger = createChildLogger({ module: 'services/password' });
const AUTH = env.security.auth;
const INVALID_RESET = 'Password reset link is invalid or has expired';

/** Frontend path of the admin portal's reset page (adminauth). */
export const ADMIN_RESET_PATH = '/admin/reset-password';

/** Reset URL for a portal. */
export function buildResetUrl({ portal, token, tenantRef = null }) {
  const base = env.cors.clientUrl;
  return portal === 'user'
    ? `${base}/login/reset?token=${encodeURIComponent(token)}&tenant=${encodeURIComponent(tenantRef ?? '')}`
    : `${base}${ADMIN_RESET_PATH}?token=${encodeURIComponent(token)}`;
}

/** Create a single-use reset token row and return the raw token. */
async function issueToken({ portal, actorId, tenantId = null }) {
  const token = randomBytes(32).toString('base64url');
  await passwordResetTokenRepository.create({
    portal,
    actorId: String(actorId),
    tenantId: portal === 'user' ? tenantId : null,
    tokenHash: digestToken(token),
    expiresAt: new Date(Date.now() + AUTH.passwordResetTokenTtlMs),
  });
  return token;
}

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
  // Only active accounts may reset. In particular an `invited` account
  // (provisioned by an invitation that may since have been revoked or
  // expired) must not be able to activate itself through password reset.
  if (account && account.status === 'active') {
    const token = randomBytes(32).toString('base64url');
    const tokenRow = await passwordResetTokenRepository.create({
      portal,
      actorId: String(account._id),
      tenantId: portal === 'user' ? resolvedTenantId : null,
      tokenHash: digestToken(token),
      expiresAt: new Date(Date.now() + AUTH.passwordResetTokenTtlMs),
    });
    // The requester is the signed-in operator (support recovery) when there
    // is one, otherwise the account holder the email belongs to.
    const holder = { type: portal, id: String(account._id), display: normalized };
    await securityEvent('PASSWORD_RESET_REQUESTED', {
      actor: getCurrentActor() ?? holder,
      tenantId: portal === 'user' ? resolvedTenantId : null,
      resource: { type: portal, id: String(account._id) },
      metadata: { portal },
    });

    const resetUrl = buildResetUrl({ portal, token, tenantRef: tenant?.slug ?? tenantId });
    try {
      // Recorded in the email outbox and attempted now; a failed attempt is
      // retried by the email job while the link is still valid.
      const outcome = await outboxService.sendNow({
        tenantId: portal === 'user' ? resolvedTenantId : null,
        to: normalized,
        template: 'auth.password_reset',
        variables: {
          resetUrl,
          expiresIn: describeDuration(AUTH.passwordResetTokenTtlMs),
        },
        idempotencyKey: `password-reset:${String(tokenRow._id)}`,
      });
      logger.info({ portal, actorId: String(account._id), outbox: outcome.status }, 'password reset email processed');
    } catch (err) {
      logger.error({ err: { message: err?.message } }, 'password reset email delivery failed');
    }
  }
  return { ok: true };
}

/**
 * adminauth: email a reset link to an admin whose password another super
 * admin has just reset (the old password is already void). Delivery
 * failures are reported, never thrown: the reset itself already happened.
 *
 * @param {Object} params
 * @param {Object} params.account - lean admin document (`_id`, `email`).
 * @returns {Promise<{ delivered: boolean, expiresAt: Date }>}
 */
export async function issueAdminAssistedReset({ account }) {
  const token = await issueToken({ portal: 'admin', actorId: account._id });
  const resetUrl = buildResetUrl({ portal: 'admin', token });
  const expiresAt = new Date(Date.now() + AUTH.passwordResetTokenTtlMs);
  try {
    // Through the email outbox (retried by the email job if this attempt fails).
    const outcome = await outboxService.sendNow({
      to: account.email,
      template: 'admin.password_reset_by_admin',
      variables: { resetUrl, expiresIn: describeDuration(AUTH.passwordResetTokenTtlMs) },
    });
    const delivered = outcome.status === 'sent';
    logger.info({ actorId: String(account._id), delivered }, 'admin-assisted password reset email recorded');
    return { delivered, expiresAt };
  } catch (err) {
    logger.error({ err: { message: err?.message } }, 'admin-assisted password reset email delivery failed');
    return { delivered: false, expiresAt };
  }
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
  if (!account || account.status !== 'active' ||
      (portal === 'user' && String(account.tenantId) !== String(resolvedTenantId))) {
    throw ApiError.badRequest(INVALID_RESET);
  }

  const newHash = await hashPassword(newPassword);
  await cfg.updatePassword(account._id, newHash);
  await cfg.clearLockout(account._id);
  const tenantOfAccount = portal === 'user' ? String(resolvedTenantId) : null;
  const sessionsRevoked = await sessionService.revokeAllForActor({
    actorId: String(account._id),
    reason: 'password_reset',
    tenantId: tenantOfAccount,
  });
  await securityEvent('PASSWORD_RESET_COMPLETED', {
    actor: { type: portal, id: String(account._id), display: account.email ?? null },
    tenantId: tenantOfAccount,
    resource: { type: portal, id: String(account._id) },
    metadata: { portal, sessionsRevoked },
  });

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
  issueAdminAssistedReset,
  buildResetUrl,
  _meta: { token: 'opaque-single-use-sha256', delivery: 'email-only', revokesSessions: true },
};
