/**
 * Admin Invitation Controller (roadmap 2.2, adminauth).
 *
 * PURPOSE
 *   Public half of the platform-admin invitation flow, used by the frontend
 *   page `/admin/accept-invite?token=...`:
 *   - `preview` -> what is being accepted (email, admin type, whether MFA
 *                  enrolment follows). POST, so the token never lands in a
 *                  URL that access logs record.
 *   - `accept`  -> set the password, activate the account and sign in: the
 *                  admin refresh cookie is set and the body is the usual
 *                  login payload (`mfaEnrollmentRequired: true` for a
 *                  privileged admin, whose session may then only enrol MFA).
 *   Business rules live in `services/adminInvitation.service.js`.
 */

import asyncHandler from '../../../utils/asyncHandler.js';
import ApiResponse from '../../../utils/ApiResponse.js';
import adminInvitationService from '../../../services/adminInvitation.service.js';
import { respondWithSession } from './auth.controller.js';

/** POST /admin-auth/invitations/preview */
export const preview = asyncHandler(async (req, res) => {
  const result = await adminInvitationService.preview({ token: req.validated.body.token });
  return ApiResponse.ok(res, result, 'Invitation is valid');
});

/** POST /admin-auth/invitations/accept */
export const accept = asyncHandler(async (req, res) => {
  const { token, password, name } = req.validated.body;
  const result = await adminInvitationService.accept({
    token,
    password,
    name,
    ip: req.ip ?? '',
    userAgent: req.headers?.['user-agent'] ?? '',
  });
  return respondWithSession(res, 'admin', result, 'Invitation accepted');
});

export default { preview, accept };
