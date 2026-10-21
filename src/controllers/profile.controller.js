/**
 * Profile Controller (onboarding, roadmap 3.6): `/users/me/password` and
 * `/users/me/sessions`. Identity comes from the token only.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import profileService from '../services/profile.service.js';

/** POST /users/me/password */
export const changePassword = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const result = await profileService.changePassword({
    userId: req.user.id,
    tenantId: req.user.tenantId,
    sessionId: req.user.sessionId ?? null,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
  });
  return ApiResponse.ok(res, result, 'Password changed');
});

/** GET /users/me/sessions */
export const listSessions = asyncHandler(async (req, res) => {
  const sessions = await profileService.listSessions({
    userId: req.user.id,
    tenantId: req.user.tenantId,
    currentSessionId: req.user.sessionId ?? null,
  });
  return ApiResponse.ok(res, sessions, 'Sessions');
});

/** DELETE /users/me/sessions/:sessionId */
export const revokeSession = asyncHandler(async (req, res) => {
  await profileService.revokeSession({ userId: req.user.id, tenantId: req.user.tenantId, sessionId: req.params.sessionId });
  return ApiResponse.noContent(res);
});

export default { changePassword, listSessions, revokeSession };
