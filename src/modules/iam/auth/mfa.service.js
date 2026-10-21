/**
 * MFA Service (Sprint 1 - implemented).
 *
 * PURPOSE
 *   TOTP enrolment + verification for platform admins, built on the
 *   encrypted `mfaSecret` field of `models/Admin.js` and otplib v13.
 *
 * RESPONSIBILITY (business rules ONLY - no raw database access)
 *   - enroll({ adminId, email })          -> generate secret + otpauth URL,
 *                                            persist the secret ENCRYPTED,
 *                                            MFA stays disabled until confirmed.
 *   - verifyEnrollment({ adminId, code }) -> confirm setup, enable MFA.
 *   - disable({ adminId })                -> wipe the secret, disable MFA.
 *   - verifyCode({ admin, code })         -> one-off challenge used by the
 *                                            login path (no persistence).
 *   - adminauth (roadmap 2.2):
 *     - verifyEnrollment also issues one-time recovery codes (returned once,
 *       stored as digests) and lifts an enrolment-only session restriction;
 *     - consumeRecoveryCode({ adminId, code }) -> single-use backup code;
 *     - regenerateRecoveryCodes({ adminId })  -> new batch (route needs step-up);
 *     - disable accepts a recovery code instead of the TOTP code, and puts the
 *       session back into enrolment-only mode when policy requires MFA;
 *     - resetByAdmin({ adminId, by })         -> admin-assisted reset (wipe +
 *       force re-enrolment).
 *
 * SECURITY RULES
 *   - The TOTP secret is NEVER stored in plain text: it is encrypted with
 *     `utils/encryption.js` under a per-admin context, so a database dump
 *     alone cannot mint codes.
 *   - Enrolment is two-step: the secret is stored with `mfaEnabled: false`
 *     and a successful TOTP challenge flips it to `true`, so an interrupted
 *     enrolment can never lock an admin out of a half-configured account.
 *   - otplib v13 ships async plugins (noble crypto + scure base32). Never
 *     import the legacy `otplib` root package - it is not present.
 *   - Enrolment start, confirmation, disable and refused disable attempts
 *     are recorded as security events (`auth.mfa.*`); the secret and codes
 *     never are.
 */

import { TOTP } from '@otplib/totp';
import { NobleCryptoPlugin } from '@otplib/plugin-crypto-noble';
import { ScureBase32Plugin } from '@otplib/plugin-base32-scure';
import env from '../../../config/env.js';
import ApiError from '../../../utils/ApiError.js';
import { encrypt, decrypt } from '../../../utils/encryption.js';
import { createChildLogger } from '../../../utils/logger.js';
import adminRepository from '../../../repositories/admin.repository.js';
import sessionRepository from '../../../repositories/session.repository.js';
import { verify as verifyPassword } from '../../../utils/password.js';
import { ERROR_CODES } from '../../../config/constants.js';
import { generateRecoveryCodes, verifyRecoveryCode, hashRecoveryCode } from '../../../utils/recoveryCodes.js';
import { securityEvent } from '../../../services/securityEvent.service.js';
import { SESSION_RESTRICTION_MFA_ENROLLMENT } from '../../../models/Session.js';
import adminMfaPolicy from './adminMfaPolicy.js';

const logger = createChildLogger({ module: 'services/mfa' });
const MFA_ISSUER = env.security.auth.mfaIssuer;
const RECOVERY_CODE_COUNT = env.security.auth.mfaRecoveryCodeCount;

/** Security-event actor for an admin acting on their own account. */
const self = (adminId, display = null) => ({ type: 'admin', id: String(adminId), display });
/** The admin account an MFA event is about. */
const onAdmin = (adminId) => ({ tenantId: null, resource: { type: 'admin', id: String(adminId) } });

/** 403 for a failed re-authentication (never 401: that would sign the SPA out). */
function reauthFailed(message = 'Password or verification code is incorrect') {
  const err = ApiError.forbidden(message);
  err.code = ERROR_CODES.STEP_UP_FAILED;
  return err;
}

/** TOTP instance shared by all admins (per-call secret, fixed params). */
const totp = new TOTP({
  algorithm: 'sha1',
  digits: 6,
  period: 30,
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
});

/**
 * Encryption context for an admin's MFA secret. The same context must be
 * used for encrypt and decrypt, so it is derived only from stable inputs.
 *
 * @param {string|ObjectId} adminId
 * @returns {{ purpose: string, subject: string }}
 */
function mfaContext(adminId) {
  return { purpose: 'mfa', subject: String(adminId) };
}

/* ------------------------------- core TOTP ------------------------------ */

/**
 * Generate a fresh random Base32 TOTP secret (for authenticator apps).
 *
 * @returns {string} Base32-encoded secret.
 */
export function generateSecret() {
  return totp.generateSecret();
}

/**
 * Build an `otpauth://` provisioning URI for the authenticator app.
 *
 * @param {Object} params
 * @param {string} params.secret - Base32 secret.
 * @param {string} params.email - account label.
 * @param {string} [params.issuer] - defaults to `security.auth.mfaIssuer`.
 * @returns {string} otpauth URI (QR payload).
 */
export function otpauthUrl({ secret, email, issuer = MFA_ISSUER }) {
  if (typeof secret !== 'string' || !secret || typeof email !== 'string' || !email) {
    throw new Error('mfa.otpauthUrl requires a secret and an email');
  }
  return totp.toURI({ secret, label: email, issuer });
}

/**
 * Verify a TOTP code against a Base32 secret with a one-window tolerance
 * (RFC 6238 transmission delay). Returns `false` on any malformed input
 * rather than throwing, so callers can treat it as a plain challenge.
 *
 * @param {string} secret - Base32 TOTP secret.
 * @param {string} code - 6-digit code from the authenticator.
 * @returns {Promise<boolean>}
 */
export async function verifySecret(secret, code) {
  if (typeof secret !== 'string' || !secret) return false;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  try {
    const result = await totp.verify(code, { secret, epochTolerance: 30 });
    return result?.valid === true;
  } catch {
    return false;
  }
}

/* ------------------------------ lifecycle ------------------------------- */

/**
 * Start TOTP enrolment. Generates a secret, builds the provisioning URI and
 * persists the secret ENCRYPTED with `mfaEnabled` still false. The caller
 * returns the secret + URI to the admin exactly once (this is the setup
 * step - the secret must never be readable from the API again).
 *
 * @param {Object} params
 * @param {string} params.adminId
 * @param {string} params.email
 * @returns {Promise<{ secret: string, otpauthUrl: string }>}
 */
export async function enroll({ adminId, email }) {
  if (!adminId || !email) throw ApiError.badRequest('adminId and email are required for MFA enrolment');
  // Re-enrolling overwrites the secret and clears mfaEnabled, which would
  // silently turn MFA off for anyone holding an access token. Refuse it;
  // disabling requires the step-up flow (password + current code).
  const current = await adminRepository.findById(adminId);
  if (!current) throw ApiError.notFound('Admin not found');
  if (current.mfaEnabled) {
    throw ApiError.conflict('MFA is already enabled. Disable it with your password and a current code before enrolling again.');
  }
  const secret = generateSecret();
  const uri = otpauthUrl({ secret, email });
  const stored = await encrypt(secret, mfaContext(adminId));
  const updated = await adminRepository.updateMfa(adminId, { mfaSecret: stored, mfaEnabled: false });
  if (!updated) throw ApiError.notFound('Admin not found');
  logger.info({ adminId }, 'mfa enrolment started');
  await securityEvent('MFA_ENROLLMENT_STARTED', { actor: self(adminId, email), ...onAdmin(adminId), metadata: { method: 'totp' } });
  return { secret, otpauthUrl: uri };
}

/**
 * Confirm an enrolment by challenging the stored secret. On success MFA is
 * turned on together with a fresh batch of one-time recovery codes, which
 * are returned here exactly once (only their digests are stored). When the
 * caller's session was restricted to enrolment, the restriction is lifted
 * for the whole login.
 *
 * @param {Object} params
 * @param {string} params.adminId
 * @param {string} params.code - 6-digit TOTP code.
 * @param {string|null} [params.sessionId] - the caller's session.
 * @returns {Promise<{ enabled: true, recoveryCodes: string[], recoveryCodesRemaining: number }>}
 */
export async function verifyEnrollment({ adminId, code, sessionId = null }) {
  const admin = await adminRepository.findById(adminId);
  if (!admin) throw ApiError.notFound('Admin not found');
  // Confirming again would mint a new batch of recovery codes without a
  // step-up; regeneration has its own (step-up) endpoint.
  if (admin.mfaEnabled) throw ApiError.conflict('MFA is already enabled');
  if (!admin.mfaSecret) throw ApiError.badRequest('MFA is not enrolled for this admin');

  const secret = await decrypt(admin.mfaSecret, mfaContext(adminId));
  const ok = await verifySecret(secret, code);
  if (!ok) throw ApiError.badRequest('Invalid verification code');

  const { codes, hashes } = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const updated = await adminRepository.enableMfa(adminId, { mfaSecret: admin.mfaSecret, recoveryCodeHashes: hashes });
  // A concurrent confirmation (or a restart of enrolment) won the race.
  if (!updated) throw ApiError.conflict('MFA enrolment changed; start again');
  if (sessionId) await sessionRepository.setRestrictionForLogin(sessionId, null);
  // Other enrolment-only sessions were opened with a password alone: end
  // them rather than let them inherit the new second factor.
  const revokedOthers = await sessionRepository.revokeRestrictedForActor(adminId, 'mfa_enrolled_elsewhere');
  logger.info({ adminId, revokedOthers }, 'mfa enrolment verified');
  await securityEvent('MFA_ENROLLED', {
    actor: self(adminId, admin.email ?? null),
    ...onAdmin(adminId),
    metadata: { method: 'totp', recoveryCodes: codes.length },
  });
  return { enabled: true, recoveryCodes: codes, recoveryCodesRemaining: codes.length };
}

/**
 * Disable MFA. Step-up: the current password AND a current TOTP code (or an
 * unused recovery code) are required. Wipes the secret and the recovery
 * codes. When the policy still requires MFA for this admin, every session
 * of the admin becomes enrolment-only, so nothing else can be done until a
 * new authenticator is enrolled.
 *
 * @param {Object} params
 * @param {string} params.adminId
 * @param {string} params.password
 * @param {string} [params.code] - 6-digit TOTP code.
 * @param {string} [params.recoveryCode] - one-time recovery code instead of `code`.
 * @param {string|null} [params.sessionId] - the caller's session.
 * @returns {Promise<{ enabled: false, enrollmentRequired: boolean }>}
 */
export async function disable({ adminId, password, code, recoveryCode, sessionId = null } = {}) {
  const admin = await adminRepository.findById(adminId);
  if (!admin) throw ApiError.notFound('Admin not found');
  if (!admin.mfaEnabled || !admin.mfaSecret) throw ApiError.badRequest('MFA is not enabled for this admin');
  if (!code && !recoveryCode) {
    throw ApiError.badRequest('Enter a code from your authenticator app or a recovery code');
  }
  const passwordOk = typeof password === 'string' && admin.passwordHash
    ? await verifyPassword(password, admin.passwordHash).catch(() => false)
    : false;
  // A recovery code is only spent once the password is proven.
  let secondOk = false;
  if (passwordOk && code) secondOk = await verifyCode({ admin, code });
  else if (passwordOk && recoveryCode) secondOk = (await consumeRecoveryCode({ adminId, code: recoveryCode })).ok;
  if (!passwordOk || !secondOk) {
    await securityEvent('MFA_DISABLE_FAILED', {
      actor: self(adminId, admin.email ?? null),
      ...onAdmin(adminId),
      reason: passwordOk ? 'invalid_code' : 'invalid_password',
      metadata: { method: code ? 'totp' : 'recovery_code', failedCheck: passwordOk ? 'code' : 'password' },
    });
    throw reauthFailed();
  }
  const updated = await adminRepository.updateMfa(adminId, { mfaSecret: null, mfaEnabled: false });
  if (!updated) throw ApiError.notFound('Admin not found');
  const enrollmentRequired = await adminMfaPolicy.isMfaRequired(updated);
  // Policy still requires MFA: every session of this admin (not only this
  // login) may now do nothing but enrol a new authenticator.
  if (enrollmentRequired) {
    await sessionRepository.restrictAllForActor(adminId, SESSION_RESTRICTION_MFA_ENROLLMENT);
  }
  logger.info({ adminId }, 'mfa disabled');
  await securityEvent('MFA_DISABLED', {
    actor: self(adminId, admin.email ?? null),
    ...onAdmin(adminId),
    metadata: { method: !code && recoveryCode ? 'recovery_code' : 'totp', viaRecoveryCode: Boolean(!code && recoveryCode), enrollmentRequired },
  });
  return { enabled: false, enrollmentRequired };
}

/**
 * Spend one recovery code. The matched digest is removed atomically, so a
 * code works exactly once even under concurrent requests.
 *
 * @param {Object} params
 * @param {string} params.adminId
 * @param {string} params.code - the code as typed.
 * @returns {Promise<{ ok: boolean, remaining: number }>}
 */
export async function consumeRecoveryCode({ adminId, code }) {
  if (!hashRecoveryCode(code)) return { ok: false, remaining: 0 };
  const state = await adminRepository.findMfaState(adminId);
  if (!state?.mfaEnabled) return { ok: false, remaining: 0 };
  const stored = state.mfaRecoveryCodes ?? [];
  const index = verifyRecoveryCode(code, stored);
  if (index < 0) return { ok: false, remaining: stored.length };
  const spent = await adminRepository.consumeRecoveryCode(adminId, stored[index]);
  // A concurrent request spent the same code first.
  if (!spent) return { ok: false, remaining: Math.max(0, stored.length - 1) };
  const after = await adminRepository.findMfaState(adminId);
  const remaining = after?.mfaRecoveryCodes?.length ?? 0;
  logger.info({ adminId, remaining }, 'mfa recovery code used');
  await securityEvent('MFA_RECOVERY_CODE_USED', { actor: self(adminId), ...onAdmin(adminId), metadata: { remaining } });
  return { ok: true, remaining };
}

/**
 * Replace the recovery codes with a fresh batch (the old ones stop working).
 * The route requires a recent step-up.
 *
 * @param {Object} params
 * @param {string} params.adminId
 * @returns {Promise<{ recoveryCodes: string[], recoveryCodesRemaining: number, generatedAt: Date }>}
 */
export async function regenerateRecoveryCodes({ adminId }) {
  const admin = await adminRepository.findById(adminId);
  if (!admin) throw ApiError.notFound('Admin not found');
  if (!admin.mfaEnabled) throw ApiError.badRequest('MFA is not enabled for this admin');
  const { codes, hashes } = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const updated = await adminRepository.replaceRecoveryCodes(adminId, hashes);
  if (!updated) throw ApiError.badRequest('MFA is not enabled for this admin');
  logger.info({ adminId }, 'mfa recovery codes regenerated');
  await securityEvent('MFA_RECOVERY_CODES_REGENERATED', { actor: self(adminId), ...onAdmin(adminId), metadata: { count: codes.length } });
  return {
    recoveryCodes: codes,
    recoveryCodesRemaining: codes.length,
    generatedAt: updated.mfaRecoveryCodesGeneratedAt,
  };
}

/**
 * Recovery-code status for the account security page (never the codes).
 *
 * @param {string} adminId
 * @returns {Promise<{ remaining: number, generatedAt: Date|null }>}
 */
export async function recoveryCodeStatus(adminId) {
  const state = await adminRepository.findMfaState(adminId);
  if (!state?.mfaEnabled) return { remaining: 0, generatedAt: null };
  return { remaining: state.mfaRecoveryCodes?.length ?? 0, generatedAt: state.mfaRecoveryCodesGeneratedAt ?? null };
}

/**
 * Admin-assisted MFA reset: wipe the secret and recovery codes and force
 * enrolment at the next sign-in. Authorisation (another active super admin,
 * never oneself, step-up) is the caller's job (`adminCredentials.service`).
 *
 * @param {Object} params
 * @param {string} params.adminId - the admin being reset.
 * @param {string|null} [params.by] - acting admin id.
 * @returns {Promise<Object>} updated admin (lean).
 */
export async function resetByAdmin({ adminId, by = null }) {
  const updated = await adminRepository.resetMfa(adminId, { by });
  if (!updated) throw ApiError.notFound('Admin not found');
  logger.info({ adminId, by }, 'mfa reset by another administrator');
  return updated;
}

/**
 * Challenge the admin's stored secret during login. Takes the lean admin
 * document (already loaded by the auth path) to avoid a second read; returns
 * `false` for any missing/malformed secret instead of throwing.
 *
 * @param {Object} params
 * @param {Object} params.admin - lean admin doc incl. `_id` + `mfaSecret`.
 * @param {string} params.code - 6-digit TOTP code.
 * @returns {Promise<boolean>}
 */
export async function verifyCode({ admin, code }) {
  if (!admin?.mfaSecret || typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  let secret;
  try {
    secret = await decrypt(admin.mfaSecret, mfaContext(admin._id));
  } catch (err) {
    logger.error({ err: { message: err?.message }, adminId: String(admin._id) }, 'mfa secret decrypt failed');
    return false;
  }
  return verifySecret(secret, code);
}

export default {
  generateSecret,
  otpauthUrl,
  verifySecret,
  enroll,
  verifyEnrollment,
  disable,
  verifyCode,
  consumeRecoveryCode,
  regenerateRecoveryCodes,
  recoveryCodeStatus,
  resetByAdmin,
  _meta: { secretAtRest: 'encrypted', twoStepEnrolment: true, recoveryCodes: 'sha256-digests-single-use' },
};
