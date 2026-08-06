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
 *   - `verifyEnrollment`  -> confirm the 6-digit code, enable MFA.
 *   - `disable`           -> wipe the secret, disable MFA.
 *
 * CODING GUIDELINES
 *   - Async handlers wrapped in `asyncHandler`.
 *   - Never call `res.json` directly; use `ApiResponse`.
 */

import asyncHandler from '../../../utils/asyncHandler.js';
import ApiResponse from '../../../utils/ApiResponse.js';
import mfaService from './mfa.service.js';

/** POST /mfa/enroll - start TOTP enrolment for the authenticated admin. */
export const enroll = asyncHandler(async (req, res) => {
  const result = await mfaService.enroll({ adminId: req.admin.id, email: req.admin.email ?? '' });
  return ApiResponse.ok(res, result, 'MFA enrolment started');
});

/** POST /mfa/verify - confirm the code, flip `mfaEnabled` on. */
export const verifyEnrollment = asyncHandler(async (req, res) => {
  const { code } = req.validated.body;
  const result = await mfaService.verifyEnrollment({ adminId: req.admin.id, code });
  return ApiResponse.ok(res, result, 'MFA enrolment verified');
});

/** POST /mfa/disable - wipe the secret and turn MFA off. */
export const disable = asyncHandler(async (req, res) => {
  const result = await mfaService.disable({ adminId: req.admin.id });
  return ApiResponse.ok(res, result, 'MFA disabled');
});

export default { enroll, verifyEnrollment, disable };
