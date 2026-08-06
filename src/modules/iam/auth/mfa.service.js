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
 */

import { TOTP } from '@otplib/totp';
import { NobleCryptoPlugin } from '@otplib/plugin-crypto-noble';
import { ScureBase32Plugin } from '@otplib/plugin-base32-scure';
import env from '../../../config/env.js';
import ApiError from '../../../utils/ApiError.js';
import { encrypt, decrypt } from '../../../utils/encryption.js';
import { createChildLogger } from '../../../utils/logger.js';
import adminRepository from '../../../repositories/admin.repository.js';

const logger = createChildLogger({ module: 'services/mfa' });
const MFA_ISSUER = env.security.auth.mfaIssuer;

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
  const secret = generateSecret();
  const uri = otpauthUrl({ secret, email });
  const stored = await encrypt(secret, mfaContext(adminId));
  const updated = await adminRepository.updateMfa(adminId, { mfaSecret: stored, mfaEnabled: false });
  if (!updated) throw ApiError.notFound('Admin not found');
  logger.info({ adminId }, 'mfa enrolment started');
  return { secret, otpauthUrl: uri };
}

/**
 * Confirm an enrolment by challenging the stored secret. On success the
 * stored secret (unchanged ciphertext) is re-persisted with
 * `mfaEnabled: true`, so a valid code is required from here on.
 *
 * @param {Object} params
 * @param {string} params.adminId
 * @param {string} params.code - 6-digit TOTP code.
 * @returns {Promise<{ enabled: boolean }>}
 */
export async function verifyEnrollment({ adminId, code }) {
  const admin = await adminRepository.findById(adminId);
  if (!admin) throw ApiError.notFound('Admin not found');
  if (!admin.mfaSecret) throw ApiError.badRequest('MFA is not enrolled for this admin');

  const secret = await decrypt(admin.mfaSecret, mfaContext(adminId));
  const ok = await verifySecret(secret, code);
  if (!ok) throw ApiError.badRequest('Invalid verification code');

  await adminRepository.updateMfa(adminId, { mfaSecret: admin.mfaSecret, mfaEnabled: true });
  logger.info({ adminId }, 'mfa enrolment verified');
  return { enabled: true };
}

/**
 * Disable MFA: wipe the secret (which also forces `mfaEnabled` off via the
 * repository invariant).
 *
 * @param {Object} params
 * @param {string} params.adminId
 * @returns {Promise<{ enabled: boolean }>}
 */
export async function disable({ adminId }) {
  const updated = await adminRepository.updateMfa(adminId, { mfaSecret: null });
  if (!updated) throw ApiError.notFound('Admin not found');
  logger.info({ adminId }, 'mfa disabled');
  return { enabled: false };
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
  _meta: { secretAtRest: 'encrypted', twoStepEnrolment: true },
};
