/**
 * Tenant-user MFA Controller (roadmap 4.E1, mfa-tenant).
 *
 * PURPOSE
 *   Thin HTTP layer for tenant-user TOTP enrolment, disable, recovery codes
 *   and step-up under `/api/v1/auth`. Identity and tenant always come from
 *   `req.user` (set by `authenticate`), never from the request body. All
 *   business rules live in `tenantMfa.service.js`.
 *
 * RESPONSIBILITY
 *   - `enroll`                  -> secret + otpauth URL (returned once).
 *   - `verifyEnrollment`        -> MFA on, recovery codes returned once.
 *   - `disable`                 -> inline step-up, MFA off.
 *   - `regenerateRecoveryCodes` -> fresh batch (route needs a step-up).
 *   - `stepUp`                  -> password + current code stamps the session.
 *   - Responses that carry secrets are marked `Cache-Control: no-store`.
 */

import asyncHandler from '../../../utils/asyncHandler.js';
import ApiResponse from '../../../utils/ApiResponse.js';
import tenantMfaService from './tenantMfa.service.js';

/** Secrets in a response must never be cached by a browser or proxy. */
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

/** The caller's identity from the verified token. */
function caller(req) {
  return { userId: req.user.id, tenantId: req.user.tenantId, sessionId: req.user.sessionId ?? null };
}

/** POST /auth/mfa/enroll */
export const enroll = asyncHandler(async (req, res) => {
  const { userId, tenantId } = caller(req);
  const result = await tenantMfaService.enroll({ userId, tenantId });
  noStore(res);
  return ApiResponse.ok(res, result, 'MFA enrolment started');
});

/** POST /auth/mfa/verify */
export const verifyEnrollment = asyncHandler(async (req, res) => {
  const { code } = req.validated.body;
  const result = await tenantMfaService.verifyEnrollment({ ...caller(req), code });
  noStore(res);
  return ApiResponse.ok(res, result, 'MFA enrolment verified');
});

/** POST /auth/mfa/disable */
export const disable = asyncHandler(async (req, res) => {
  const { password, code, recoveryCode } = req.validated.body;
  const { userId, tenantId } = caller(req);
  const result = await tenantMfaService.disable({ userId, tenantId, password, code, recoveryCode });
  return ApiResponse.ok(res, result, 'MFA disabled');
});

/** POST /auth/mfa/recovery-codes */
export const regenerateRecoveryCodes = asyncHandler(async (req, res) => {
  const { userId, tenantId } = caller(req);
  const result = await tenantMfaService.regenerateRecoveryCodes({ userId, tenantId });
  noStore(res);
  return ApiResponse.ok(res, result, 'Recovery codes regenerated');
});

/** POST /auth/step-up */
export const stepUp = asyncHandler(async (req, res) => {
  const { password, code, recoveryCode } = req.validated.body;
  const result = await tenantMfaService.stepUp({ ...caller(req), password, code, recoveryCode });
  return ApiResponse.ok(res, result, 'Identity confirmed');
});

export default { enroll, verifyEnrollment, disable, regenerateRecoveryCodes, stepUp };
