/**
 * Tenant-user MFA service (roadmap 4.E1, mfa-tenant; finding auth.12).
 *
 * PURPOSE
 *   TOTP enrolment, verification, recovery codes and step-up for TENANT
 *   users, mirroring the platform-admin design in `mfa.service.js` and
 *   `stepUp.service.js` on the `mfa*` fields of `models/User.js`.
 *
 * RESPONSIBILITY (business rules ONLY - no raw database access)
 *   - enroll({ userId, tenantId })            -> secret + otpauth URL (once),
 *                                               stored ENCRYPTED, MFA still off.
 *   - verifyEnrollment({ userId, ..., code })  -> MFA on, one-time recovery
 *                                               codes returned once, an
 *                                               enrolment-only session lifted.
 *   - disable({ ..., password, code | recoveryCode }) -> inline step-up, wipe.
 *   - verifyCode({ user, code })              -> login/step-up challenge; a
 *                                               code is accepted ONCE.
 *   - consumeRecoveryCode / regenerateRecoveryCodes / recoveryCodeStatus.
 *   - stepUp({ ..., password, code | recoveryCode }) -> stamps the session
 *     (`Session.stepUpAt`); `requireUserStepUp()` admits sensitive requests
 *     for `USER_STEP_UP_TTL_MS`.
 *   - profileStatus({ user, session })        -> MFA fields of `/users/me`.
 *
 * SECURITY RULES
 *   - The TOTP secret is encrypted under a per-user context
 *     (`purpose: 'mfa', tenantId, subject: userId`) and its field is
 *     `select: false`; recovery codes are stored as SHA-256 digests only
 *     (`utils/recoveryCodes.js`, shared with admin MFA) and removed
 *     atomically when used.
 *   - Replay protection: the time step of every accepted TOTP code is
 *     recorded atomically (`mfaLastTimeStep`); the same code, or an older
 *     one, is refused afterwards (admin MFA does not do this yet).
 *   - Every lookup is bound to the caller's tenant (`findMfaState(id,
 *     tenantId)`), whose id comes from the verified access token.
 *   - Re-authentication failures answer 403 `STEP_UP_FAILED` (never 401,
 *     which would sign the SPA out), count toward the persisted lockout,
 *     and reaching the lockout revokes every session of the account.
 *   - Events (`auth.mfa.*`, `auth.step_up.user_*`) never carry the secret
 *     or a code.
 */

import { TOTP } from '@otplib/totp';
import { NobleCryptoPlugin } from '@otplib/plugin-crypto-noble';
import { ScureBase32Plugin } from '@otplib/plugin-base32-scure';
import env from '../../../config/env.js';
import ApiError from '../../../utils/ApiError.js';
import { ERROR_CODES } from '../../../config/constants.js';
import { encrypt, decrypt } from '../../../utils/encryption.js';
import { createChildLogger } from '../../../utils/logger.js';
import clock from '../../../utils/clock.js';
import { verify as verifyPassword } from '../../../utils/password.js';
import { generateRecoveryCodes, verifyRecoveryCode, hashRecoveryCode } from '../../../utils/recoveryCodes.js';
import userRepository from '../../../repositories/user.repository.js';
import sessionRepository from '../../../repositories/session.repository.js';
import { securityEvent } from '../../../services/securityEvent.service.js';
import { SESSION_RESTRICTION_MFA_ENROLLMENT } from '../../../models/Session.js';
import tenantMfaPolicy from './tenantMfaPolicy.js';

const logger = createChildLogger({ module: 'services/tenant_mfa' });
const AUTH = env.security.auth;
const MFA_ISSUER = AUTH.mfaIssuer;
const RECOVERY_CODE_COUNT = AUTH.mfaRecoveryCodeCount;
const MFA_ENROLLMENT_TTL_MS = 10 * 60 * 1000;

/** Step-up window length in ms for tenant users. */
export const USER_STEP_UP_TTL_MS = AUTH.userStepUpTtlMs;

/** TOTP parameters identical to admin MFA (sha1, 6 digits, 30 s). */
const totp = new TOTP({
  algorithm: 'sha1',
  digits: 6,
  period: 30,
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
});

/** Security-event actor for a user acting on their own account. */
const self = (user) => ({ type: 'user', id: String(user._id ?? user.id), display: user.email ?? null });
/** Tenant + resource of an event about this user. */
const onUser = (user) => ({ tenantId: String(user.tenantId), resource: { type: 'user', id: String(user._id ?? user.id) } });

/** Encryption context of a user's TOTP secret (stable inputs only). */
function mfaContext(userId, tenantId) {
  return { purpose: 'mfa', tenantId: String(tenantId), subject: String(userId) };
}

/** 403 for a failed re-authentication. */
function reauthFailed() {
  const err = ApiError.forbidden('Password or verification code is incorrect');
  err.code = ERROR_CODES.STEP_UP_FAILED;
  return err;
}

/** Load the caller's MFA state, bound to their tenant. */
async function loadState(userId, tenantId) {
  if (!userId || !tenantId) throw ApiError.unauthorized('Authentication required');
  const user = await userRepository.findMfaState(userId, tenantId);
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

/* ------------------------------- core TOTP ------------------------------ */

/**
 * Check a TOTP code against a Base32 secret (one-window tolerance).
 *
 * @returns {Promise<number|null>} the matched time step, or null.
 */
async function matchTimeStep(secret, code) {
  if (typeof secret !== 'string' || !secret) return null;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  try {
    // The injectable clock lets tests step through TOTP periods.
    const epoch = Math.floor(clock.now().getTime() / 1000);
    const result = await totp.verify(code, { secret, epoch, epochTolerance: 30 });
    return result?.valid === true && Number.isFinite(result.timeStep) ? result.timeStep : null;
  } catch {
    return null;
  }
}

/** Decrypt a user's stored secret; null (logged) when it cannot be read. */
async function readSecret(user) {
  if (!user?.mfaSecret) return null;
  try {
    return await decrypt(user.mfaSecret, mfaContext(user._id, user.tenantId));
  } catch (err) {
    logger.error({ err: { message: err?.message }, userId: String(user._id) }, 'tenant mfa secret decrypt failed');
    return null;
  }
}

/**
 * Challenge an ENABLED user's secret (login, step-up, disable). A code is
 * accepted at most once: its time step must be newer than the last one
 * used, recorded atomically.
 *
 * @param {Object} params
 * @param {Object} params.user - MFA state (`findMfaState`), incl. `mfaSecret`.
 * @param {string} params.code - 6-digit TOTP code.
 * @returns {Promise<boolean>}
 */
export async function verifyCode({ user, code }) {
  if (!user?.mfaEnabled) return false;
  const step = await matchTimeStep(await readSecret(user), code);
  if (step === null) return false;
  const fresh = await userRepository.markTotpStepUsed(user._id, step);
  if (!fresh) logger.warn({ userId: String(user._id) }, 'tenant mfa code replay refused');
  return fresh;
}

/* ------------------------------ lifecycle ------------------------------- */

/**
 * Start TOTP enrolment: a fresh secret is stored encrypted with MFA still
 * off. The secret and URI are returned to the caller exactly once.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.tenantId
 * @returns {Promise<{ secret: string, otpauthUrl: string }>}
 */
export async function enroll({ userId, tenantId }) {
  const user = await loadState(userId, tenantId);
  if (user.mfaEnabled) {
    throw ApiError.conflict('MFA is already enabled. Turn it off with your password and a current code before enrolling again.');
  }
  const secret = totp.generateSecret();
  const uri = totp.toURI({ secret, label: user.email, issuer: MFA_ISSUER });
  const stored = await encrypt(secret, mfaContext(user._id, user.tenantId));
  const expiresAt = new Date(Date.now() + MFA_ENROLLMENT_TTL_MS);
  const updated = await userRepository.startMfaEnrollment(user._id, stored, expiresAt);
  // A concurrent confirmation turned MFA on in between.
  if (!updated) throw ApiError.conflict('MFA is already enabled');
  logger.info({ userId: String(user._id) }, 'tenant mfa enrolment started');
  await securityEvent('MFA_ENROLLMENT_STARTED', { actor: self(user), ...onUser(user), metadata: { method: 'totp', portal: 'user' } });
  return { secret, otpauthUrl: uri };
}

/**
 * Confirm enrolment with a current code. Turns MFA on with a fresh batch of
 * recovery codes (returned once). The caller's enrolment-only session is
 * lifted for the whole login; other enrolment-only sessions are revoked
 * (they were opened with a password alone).
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.tenantId
 * @param {string} params.code
 * @param {string|null} [params.sessionId]
 * @returns {Promise<{ enabled: true, recoveryCodes: string[], recoveryCodesRemaining: number }>}
 */
export async function verifyEnrollment({ userId, tenantId, code, sessionId = null }) {
  const user = await loadState(userId, tenantId);
  if (user.mfaEnabled) throw ApiError.conflict('MFA is already enabled');
  if (!user.mfaSecret) throw ApiError.badRequest('Start MFA enrolment first');
  const now = new Date();
  if (!user.mfaEnrollmentExpiresAt || new Date(user.mfaEnrollmentExpiresAt).getTime() <= now.getTime()) {
    await userRepository.clearExpiredMfaEnrollment(user._id, user.mfaSecret, now);
    throw ApiError.gone('MFA enrollment expired. Start again.');
  }
  const step = await matchTimeStep(await readSecret(user), code);
  if (step === null) throw ApiError.badRequest('Invalid verification code');

  const { codes, hashes } = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const updated = await userRepository.enableMfa(user._id, { mfaSecret: user.mfaSecret, recoveryCodeHashes: hashes, timeStep: step });
  if (!updated) throw ApiError.gone('MFA enrollment expired or changed. Start again.');
  if (sessionId) await sessionRepository.setRestrictionForLogin(sessionId, null);
  const revokedOthers = await sessionRepository.revokeRestrictedForActor(user._id, 'mfa_enrolled_elsewhere');
  logger.info({ userId: String(user._id), revokedOthers }, 'tenant mfa enrolment verified');
  await securityEvent('MFA_ENROLLED', {
    actor: self(user),
    ...onUser(user),
    metadata: { method: 'totp', portal: 'user', recoveryCodes: codes.length },
  });
  return { enabled: true, recoveryCodes: codes, recoveryCodesRemaining: codes.length };
}

/**
 * Spend one recovery code (atomically, so it works exactly once).
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.tenantId
 * @param {string} params.code
 * @returns {Promise<{ ok: boolean, remaining: number }>}
 */
export async function consumeRecoveryCode({ userId, tenantId, code }) {
  if (!hashRecoveryCode(code)) return { ok: false, remaining: 0 };
  const state = await userRepository.findMfaState(userId, tenantId);
  if (!state?.mfaEnabled) return { ok: false, remaining: 0 };
  const stored = state.mfaRecoveryCodes ?? [];
  const index = verifyRecoveryCode(code, stored);
  if (index < 0) return { ok: false, remaining: stored.length };
  const spent = await userRepository.consumeRecoveryCode(state._id, stored[index]);
  if (!spent) return { ok: false, remaining: Math.max(0, stored.length - 1) };
  const remaining = stored.length - 1;
  logger.info({ userId: String(state._id), remaining }, 'tenant mfa recovery code used');
  await securityEvent('MFA_RECOVERY_CODE_USED', { actor: self(state), ...onUser(state), metadata: { portal: 'user', remaining } });
  return { ok: true, remaining };
}

/**
 * Check password + second factor for an inline step-up (disable). The
 * recovery code is only spent once the password is proven.
 *
 * @returns {Promise<{ passwordOk: boolean, secondOk: boolean, method: string, remaining?: number }>}
 */
async function reauthenticate(user, { password, code, recoveryCode }) {
  const passwordOk = typeof password === 'string' && password.length > 0 && user.passwordHash
    ? await verifyPassword(password, user.passwordHash).catch(() => false)
    : false;
  const method = !user.mfaEnabled ? 'password' : code ? 'totp' : 'recovery_code';
  if (!passwordOk) return { passwordOk, secondOk: false, method };
  if (!user.mfaEnabled) return { passwordOk, secondOk: true, method };
  if (code) return { passwordOk, secondOk: await verifyCode({ user, code }), method };
  const used = await consumeRecoveryCode({ userId: user._id, tenantId: user.tenantId, code: recoveryCode });
  return { passwordOk, secondOk: used.ok, method, ...(used.ok ? { remaining: used.remaining } : {}) };
}

/** Count a failed re-authentication toward the persisted lockout. */
async function recordReauthFailure(user, source) {
  const id = String(user._id);
  const updated = await userRepository.incrementFailedAttempts(id);
  const attempts = updated?.failedAttempts ?? (user.failedAttempts ?? 0) + 1;
  if (attempts >= AUTH.loginMaxAttempts) {
    await userRepository.setLockedUntil(id, new Date(Date.now() + AUTH.loginLockoutMs));
    const revoked = await sessionRepository.revokeAllForActor(id, 'step_up_lockout');
    logger.warn({ userId: id, revoked }, 'tenant re-authentication failures locked the account; sessions revoked');
    await securityEvent('LOCKOUT', {
      actor: self(user),
      ...onUser(user),
      metadata: { portal: 'user', source, sessionsRevoked: revoked },
    });
  }
}

/**
 * Turn MFA off. Step-up inline: the current password AND a current TOTP
 * code (or an unused recovery code). When the policy still requires MFA,
 * every session of the user becomes enrolment-only.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.tenantId
 * @param {string} params.password
 * @param {string} [params.code]
 * @param {string} [params.recoveryCode]
 * @returns {Promise<{ enabled: false, enrollmentRequired: boolean }>}
 */
export async function disable({ userId, tenantId, password, code, recoveryCode } = {}) {
  const user = await loadState(userId, tenantId);
  if (!user.mfaEnabled) throw ApiError.badRequest('MFA is not enabled for this account');
  if (!code && !recoveryCode) throw ApiError.badRequest('Enter a code from your authenticator app or a recovery code');
  const check = await reauthenticate(user, { password, code, recoveryCode });
  if (!check.passwordOk || !check.secondOk) {
    await recordReauthFailure(user, 'mfa_disable');
    await securityEvent('MFA_DISABLE_FAILED', {
      actor: self(user),
      ...onUser(user),
      reason: check.passwordOk ? 'invalid_code' : 'invalid_password',
      metadata: { portal: 'user', method: check.method, failedCheck: check.passwordOk ? 'code' : 'password' },
    });
    throw reauthFailed();
  }
  const updated = await userRepository.disableMfa(user._id);
  if (!updated) throw ApiError.conflict('MFA is not enabled for this account');
  await userRepository.resetFailedAttempts(String(user._id));
  const enrollmentRequired = await tenantMfaPolicy.isMfaRequired(updated);
  if (enrollmentRequired) await sessionRepository.restrictAllForActor(user._id, SESSION_RESTRICTION_MFA_ENROLLMENT);
  logger.info({ userId: String(user._id) }, 'tenant mfa disabled');
  await securityEvent('MFA_DISABLED', {
    actor: self(user),
    ...onUser(user),
    metadata: { portal: 'user', method: check.method, viaRecoveryCode: check.method === 'recovery_code', enrollmentRequired },
  });
  return { enabled: false, enrollmentRequired };
}

/**
 * Replace the recovery codes with a fresh batch (the old ones stop working).
 * The route requires a fresh step-up.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.tenantId
 * @returns {Promise<{ recoveryCodes: string[], recoveryCodesRemaining: number, generatedAt: Date }>}
 */
export async function regenerateRecoveryCodes({ userId, tenantId }) {
  const user = await loadState(userId, tenantId);
  if (!user.mfaEnabled) throw ApiError.badRequest('MFA is not enabled for this account');
  const { codes, hashes } = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const updated = await userRepository.replaceRecoveryCodes(user._id, hashes);
  if (!updated) throw ApiError.badRequest('MFA is not enabled for this account');
  await securityEvent('USER_MFA_RECOVERY_CODES_REGENERATED', { actor: self(user), ...onUser(user), metadata: { count: codes.length } });
  return { recoveryCodes: codes, recoveryCodesRemaining: codes.length, generatedAt: updated.mfaRecoveryCodesGeneratedAt };
}

/**
 * Re-authenticate the signed-in user and open a step-up window on the
 * current session. Users with MFA must present a code (or a recovery code);
 * a user without MFA, outside the policy, steps up with the password.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.tenantId
 * @param {string} params.sessionId
 * @param {string} params.password
 * @param {string} [params.code]
 * @param {string} [params.recoveryCode]
 * @returns {Promise<{ stepUpExpiresAt: string, recoveryCodesRemaining?: number }>}
 */
export async function stepUp({ userId, tenantId, sessionId, password, code, recoveryCode }) {
  if (!sessionId) throw ApiError.unauthorized('Session is no longer active');
  const user = await loadState(userId, tenantId);
  if (user.status !== 'active') throw ApiError.unauthorized('Session is no longer active');
  if (!user.mfaEnabled && (await tenantMfaPolicy.isMfaRequired(user))) {
    const err = ApiError.forbidden('Set up multi-factor authentication to continue');
    err.code = ERROR_CODES.MFA_ENROLLMENT_REQUIRED;
    throw err;
  }
  if (user.mfaEnabled && !code && !recoveryCode) {
    throw ApiError.badRequest('Enter a code from your authenticator app or a recovery code');
  }
  const check = await reauthenticate(user, { password, code, recoveryCode });
  if (!check.passwordOk || !check.secondOk) {
    await recordReauthFailure(user, 'step_up');
    await securityEvent('USER_STEP_UP_FAILED', {
      actor: self(user),
      ...onUser(user),
      reason: check.passwordOk ? 'invalid_code' : 'invalid_password',
      metadata: { method: check.method },
    });
    throw reauthFailed();
  }
  const at = new Date();
  const marked = await sessionRepository.markSteppedUp(sessionId, at);
  if (!marked || String(marked.actorId) !== String(user._id)) throw ApiError.unauthorized('Session is no longer active');
  await userRepository.resetFailedAttempts(String(user._id));
  await securityEvent('USER_STEP_UP_SUCCEEDED', { actor: self(user), ...onUser(user), metadata: { method: check.method } });
  return {
    stepUpExpiresAt: new Date(at.getTime() + USER_STEP_UP_TTL_MS).toISOString(),
    ...(check.remaining !== undefined ? { recoveryCodesRemaining: check.remaining } : {}),
  };
}

/**
 * True when a tenant step-up stamped at `stepUpAt` is still in its window.
 *
 * @param {Date|string|number|null} stepUpAt
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isUserStepUpFresh(stepUpAt, now = Date.now()) {
  if (stepUpAt === null || stepUpAt === undefined) return false;
  const at = typeof stepUpAt === 'number' ? stepUpAt : new Date(stepUpAt).getTime();
  return Number.isFinite(at) && at <= now + 1000 && now - at <= USER_STEP_UP_TTL_MS;
}

/**
 * MFA fields for the caller's profile (`GET /users/me`), never a secret.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.tenantId
 * @param {{ restriction?: string|null, stepUpAt?: number|null }} [params.session]
 * @returns {Promise<Object>}
 */
export async function profileStatus({ userId, tenantId, session = null }) {
  const user = await loadState(userId, tenantId);
  const [required, workspaceRequired] = await Promise.all([
    tenantMfaPolicy.isMfaRequired(user),
    tenantMfaPolicy.isWorkspaceMfaRequired(user.tenantId),
  ]);
  const end = session?.stepUpAt ? Number(session.stepUpAt) + USER_STEP_UP_TTL_MS : NaN;
  return {
    enabled: Boolean(user.mfaEnabled),
    required,
    workspaceRequired,
    enrollmentRequired: session?.restriction === SESSION_RESTRICTION_MFA_ENROLLMENT,
    recoveryCodesRemaining: user.mfaEnabled ? (user.mfaRecoveryCodes?.length ?? 0) : 0,
    recoveryCodesGeneratedAt: user.mfaEnabled ? user.mfaRecoveryCodesGeneratedAt ?? null : null,
    stepUpExpiresAt: Number.isFinite(end) && end > Date.now() ? new Date(end).toISOString() : null,
  };
}

/**
 * Login-path second factor for tenant users.
 *   - MFA on: a TOTP code or a one-time recovery code is required (the
 *     caller answers 401 `MFA_REQUIRED` without either; a wrong one is a
 *     failed login).
 *   - MFA off and the policy requires it: the login succeeds with a
 *     session restricted to MFA enrolment.
 *
 * @param {Object} params
 * @param {Object} params.account - lean auth projection of the user.
 * @param {string} [params.mfaCode]
 * @param {string} [params.recoveryCode]
 * @returns {Promise<{ outcome: 'ok'|'missing'|'invalid'|'enroll', recoveryCodesRemaining?: number }>}
 */
export async function loginChallenge({ account, mfaCode, recoveryCode }) {
  if (account.mfaEnabled) {
    if (!mfaCode && !recoveryCode) return { outcome: 'missing' };
    if (mfaCode) {
      const user = await userRepository.findMfaState(account._id, account.tenantId);
      return { outcome: (await verifyCode({ user, code: mfaCode })) ? 'ok' : 'invalid' };
    }
    const used = await consumeRecoveryCode({ userId: account._id, tenantId: account.tenantId, code: recoveryCode });
    return used.ok ? { outcome: 'ok', recoveryCodesRemaining: used.remaining } : { outcome: 'invalid' };
  }
  if (await tenantMfaPolicy.isMfaRequired(account)) {
    await securityEvent('USER_MFA_ENROLLMENT_ENFORCED', {
      actor: self(account),
      ...onUser(account),
      metadata: { reason: account.mfaEnrollmentRequired ? 'owner_reset' : 'workspace_policy' },
    });
    return { outcome: 'enroll' };
  }
  return { outcome: 'ok' };
}

export default {
  enroll,
  verifyEnrollment,
  verifyCode,
  disable,
  consumeRecoveryCode,
  regenerateRecoveryCodes,
  stepUp,
  isUserStepUpFresh,
  profileStatus,
  loginChallenge,
  USER_STEP_UP_TTL_MS,
  _meta: { secretAtRest: 'encrypted', twoStepEnrolment: true, recoveryCodes: 'sha256-digests-single-use', totpReplay: 'refused' },
};
