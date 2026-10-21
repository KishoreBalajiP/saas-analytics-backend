/**
 * MFA Controller (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Thin HTTP layer for TOTP enrolment + verification for platform admins.
 *   Identity always comes from `req.admin` (set by `adminAuth.middleware.js`),
 *   so these endpoints are mounted behind `adminAuth` and never take an
 *   admin id from the request body. All business rules live in
 *   `mfa.service.js`.
 *
 * RESPONSIBILITY
 *   - `enroll`            -> generate secret + otpauth URL (returned once).
 *   - `verifyEnrollment`  -> confirm the 6-digit code, enable MFA and return
 *                            the one-time recovery codes (shown once).
 *   - `disable`           -> step-up inline (password + code or recovery
 *                            code), wipe the secret, disable MFA.
 *   - adminauth: `regenerateRecoveryCodes` (route requires a fresh step-up)
 *     and `stepUp` (password + current code opens a short window on this
 *     session for sensitive actions).
 *   - Responses that carry secrets (TOTP seed, recovery codes) are marked
 *     `Cache-Control: no-store`.
 *
 * CODING GUIDELINES
 *   - Async handlers wrapped in `asyncHandler`.
 *   - Never call `res.json` directly; use `ApiResponse`.
 */

import asyncHandler from '../../../utils/asyncHandler.js';
import ApiResponse from '../../../utils/ApiResponse.js';
import mfaService from './mfa.service.js';
import stepUpService from './stepUp.service.js';

/** Secrets in a response must never be cached by a browser or proxy. */
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

/** POST /mfa/enroll - start TOTP enrolment for the authenticated admin. */
export const enroll = asyncHandler(async (req, res) => {
  const result = await mfaService.enroll({ adminId: req.admin.id, email: req.admin.email ?? '' });
  noStore(res);
  return ApiResponse.ok(res, result, 'MFA enrolment started');
});

/**
 * POST /mfa/verify - confirm the code, flip `mfaEnabled` on, return the
 * recovery codes once and lift an enrolment-only session restriction.
 */
export const verifyEnrollment = asyncHandler(async (req, res) => {
  const { code } = req.validated.body;
  const result = await mfaService.verifyEnrollment({
    adminId: req.admin.id,
    code,
    sessionId: req.admin.sessionId ?? null,
  });
  noStore(res);
  return ApiResponse.ok(res, result, 'MFA enrolment verified');
});

/** POST /mfa/disable - step-up inline, then wipe the secret and turn MFA off. */
export const disable = asyncHandler(async (req, res) => {
  const { password, code, recoveryCode } = req.validated.body;
  const result = await mfaService.disable({
    adminId: req.admin.id,
    password,
    code,
    recoveryCode,
    sessionId: req.admin.sessionId ?? null,
  });
  return ApiResponse.ok(res, result, 'MFA disabled');
});

/** POST /mfa/recovery-codes - replace the recovery codes (fresh step-up required). */
export const regenerateRecoveryCodes = asyncHandler(async (req, res) => {
  const result = await mfaService.regenerateRecoveryCodes({ adminId: req.admin.id });
  noStore(res);
  return ApiResponse.ok(res, result, 'Recovery codes regenerated');
});

/** POST /step-up - re-authenticate and open a step-up window on this session. */
export const stepUp = asyncHandler(async (req, res) => {
  const { password, code, recoveryCode } = req.validated.body;
  const result = await stepUpService.stepUp({
    adminId: req.admin.id,
    sessionId: req.admin.sessionId ?? null,
    password,
    code,
    recoveryCode,
  });
  return ApiResponse.ok(res, result, 'Identity confirmed');
});

export default { enroll, verifyEnrollment, disable, regenerateRecoveryCodes, stepUp };
