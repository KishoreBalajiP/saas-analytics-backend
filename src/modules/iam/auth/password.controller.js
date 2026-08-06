/**
 * Password Controller (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Thin HTTP layer for forgot/reset password on BOTH portals. A single
 *   factory drives the tenant portal (`/auth/password/*`) and the admin
 *   portal (`/admin-auth/password/*`) - the only difference is the portal
 *   the service layer is told to use. All business rules live in
 *   `password.service.js`.
 *
 * RESPONSIBILITY
 *   - `forgotPassword` -> always `{ ok: true }` (no user enumeration);
 *                         a reset link is emailed when the account exists.
 *   - `resetPassword`  -> verify the stateless token, set the new hash,
 *                         revoke all sessions.
 *
 * CODING GUIDELINES
 *   - Async handlers wrapped in `asyncHandler`.
 *   - Never call `res.json` directly; use `ApiResponse`.
 */

import asyncHandler from '../../../utils/asyncHandler.js';
import ApiResponse from '../../../utils/ApiResponse.js';
import passwordService from './password.service.js';

/**
 * Build the password controller for one portal.
 *
 * @param {'user'|'admin'} portal
 * @returns {Object} `{ forgotPassword, resetPassword }` Express handlers.
 */
export function createPasswordController(portal) {
  return {
    /** POST /password/forgot - request a reset link (rate-limited). */
    forgotPassword: asyncHandler(async (req, res) => {
      const { email } = req.validated.body;
      const tenantId = portal === 'user' ? (req.tenant?.id ?? null) : null;
      const result = await passwordService.requestReset({ portal, email, tenantId });
      return ApiResponse.ok(res, result, 'If the account exists, a reset link has been sent');
    }),

    /** POST /password/reset - complete the reset with the emailed token. */
    resetPassword: asyncHandler(async (req, res) => {
      const { token, newPassword } = req.validated.body;
      const tenantId = portal === 'user' ? (req.tenant?.id ?? null) : null;
      const result = await passwordService.resetPassword({ portal, token, newPassword, tenantId });
      return ApiResponse.ok(res, result, 'Password updated');
    }),
  };
}

export const userPasswordController = createPasswordController('user');
export const adminPasswordController = createPasswordController('admin');

export default { createPasswordController, userPasswordController, adminPasswordController };
