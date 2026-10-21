/**
 * Admin step-up re-authentication (roadmap 2.2, adminauth).
 *
 * PURPOSE
 *   Sensitive admin actions (granting super, resetting another admin's
 *   credentials, reading secret settings, regenerating recovery codes) need
 *   proof that the person at the keyboard is the account holder NOW, not
 *   just a valid access token. A step-up re-checks the password plus a
 *   current TOTP code (or an unused recovery code) and stamps the caller's
 *   session (`Session.stepUpAt`); `requireAdminStepUp` then admits sensitive
 *   requests on that session for `ADMIN_STEP_UP_TTL_MS` (default 5 min).
 *
 * SECURITY RULES
 *   - Server-side only: the window lives on the session document, bound to
 *     this login; another session (or a stolen access token for another
 *     login) gets nothing from it.
 *   - Admins with MFA must present a code; a password alone is accepted
 *     only for an admin outside the MFA policy (documented degradation when
 *     ADMIN_MFA_REQUIRED_TYPES=none). A recovery code is spent only after
 *     the password is proven.
 *   - Failures answer 403 `STEP_UP_FAILED` (never 401, which would sign the
 *     SPA out), are rate-limited per admin, and count toward the persisted
 *     lockout. Reaching the lockout threshold through step-up failures also
 *     revokes every session of the account: someone holding a session is
 *     guessing its owner's password.
 */

import env from '../../../config/env.js';
import ApiError from '../../../utils/ApiError.js';
import { ERROR_CODES } from '../../../config/constants.js';
import { createChildLogger } from '../../../utils/logger.js';
import { verify as verifyPassword } from '../../../utils/password.js';
import adminRepository from '../../../repositories/admin.repository.js';
import sessionRepository from '../../../repositories/session.repository.js';
import { securityEvent } from '../../../services/securityEvent.service.js';
import mfaService from './mfa.service.js';
import adminMfaPolicy from './adminMfaPolicy.js';

const logger = createChildLogger({ module: 'services/stepUp' });
const AUTH = env.security.auth;

/** Step-up window length in ms. */
export const STEP_UP_TTL_MS = AUTH.adminStepUpTtlMs;

function failed() {
  const err = ApiError.forbidden('Password or verification code is incorrect');
  err.code = ERROR_CODES.STEP_UP_FAILED;
  return err;
}

/**
 * True when a step-up stamped at `stepUpAt` (Date, ISO string or epoch ms)
 * is still inside the window.
 *
 * @param {Date|string|number|null} stepUpAt
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isStepUpFresh(stepUpAt, now = Date.now()) {
  if (stepUpAt === null || stepUpAt === undefined) return false;
  const at = typeof stepUpAt === 'number' ? stepUpAt : new Date(stepUpAt).getTime();
  return Number.isFinite(at) && at <= now + 1000 && now - at <= STEP_UP_TTL_MS;
}

/** Count a failed step-up toward the persisted lockout. */
async function recordFailure(admin) {
  const id = String(admin._id);
  const updated = await adminRepository.incrementFailedAttempts(id);
  const attempts = updated?.failedAttempts ?? (admin.failedAttempts ?? 0) + 1;
  if (attempts >= AUTH.loginMaxAttempts) {
    await adminRepository.setLockedUntil(id, new Date(Date.now() + AUTH.loginLockoutMs));
    const revoked = await sessionRepository.revokeAllForActor(id, 'step_up_lockout');
    logger.warn({ adminId: id, revoked }, 'step-up failures locked the account; sessions revoked');
    await securityEvent('LOCKOUT', { actor: { type: 'admin', id }, metadata: { source: 'step_up', sessionsRevoked: revoked } });
  }
}

/**
 * Re-authenticate the signed-in admin and open a step-up window on the
 * current session.
 *
 * @param {Object} params
 * @param {string} params.adminId - from the verified token.
 * @param {string} params.sessionId - from the verified token.
 * @param {string} params.password
 * @param {string} [params.code] - 6-digit TOTP code.
 * @param {string} [params.recoveryCode] - one-time recovery code instead of `code`.
 * @returns {Promise<{ stepUpExpiresAt: string, recoveryCodesRemaining?: number }>}
 */
export async function stepUp({ adminId, sessionId, password, code, recoveryCode }) {
  const admin = await adminRepository.findById(adminId);
  if (!admin || admin.status !== 'active') throw ApiError.unauthorized('Session is no longer active');
  if (!sessionId) throw ApiError.unauthorized('Session is no longer active');

  if (!admin.mfaEnabled && (await adminMfaPolicy.isMfaRequired(admin))) {
    const err = ApiError.forbidden('Set up multi-factor authentication to continue');
    err.code = ERROR_CODES.MFA_ENROLLMENT_REQUIRED;
    throw err;
  }
  if (admin.mfaEnabled && !code && !recoveryCode) {
    throw ApiError.badRequest('Enter a code from your authenticator app or a recovery code');
  }

  const passwordOk = typeof password === 'string' && password.length > 0 && admin.passwordHash
    ? await verifyPassword(password, admin.passwordHash).catch(() => false)
    : false;

  let secondOk = !admin.mfaEnabled;
  let recoveryCodesRemaining;
  if (passwordOk && admin.mfaEnabled) {
    if (code) {
      secondOk = await mfaService.verifyCode({ admin, code });
    } else {
      const used = await mfaService.consumeRecoveryCode({ adminId, code: recoveryCode });
      secondOk = used.ok;
      if (used.ok) recoveryCodesRemaining = used.remaining;
    }
  }

  if (!passwordOk || !secondOk) {
    await recordFailure(admin);
    await securityEvent('STEP_UP_FAILED', { actor: { type: 'admin', id: String(adminId) } });
    throw failed();
  }

  const at = new Date();
  const marked = await sessionRepository.markSteppedUp(sessionId, at);
  if (!marked) throw ApiError.unauthorized('Session is no longer active');
  await adminRepository.resetFailedAttempts(String(adminId));
  await securityEvent('STEP_UP_SUCCEEDED', {
    actor: { type: 'admin', id: String(adminId) },
    metadata: { method: !admin.mfaEnabled ? 'password' : code ? 'totp' : 'recovery_code' },
  });
  return {
    stepUpExpiresAt: new Date(at.getTime() + STEP_UP_TTL_MS).toISOString(),
    ...(recoveryCodesRemaining !== undefined ? { recoveryCodesRemaining } : {}),
  };
}

export default { stepUp, isStepUpFresh, STEP_UP_TTL_MS };
