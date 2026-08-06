/**
 * Admin Controller (Sprint 1 - auth surface delegated).
 *
 * PURPOSE
 *   HTTP-layer entry for the `/api/v1/admin` and `/api/v1/admin-auth`
 *   surface.
 *
 * RESPONSIBILITY
 *   - /admin-auth handlers delegate to the real module controllers
 *     (`src/modules/iam/auth/`) - kept here as a compatibility alias so
 *     import paths documented in early phases keep working.
 *   - /admin CRUD handlers remain fail-closed `501` placeholders until the
 *     admin-management surface lands (Sprint 2).
 *
 * CODING GUIDELINES
 *   - All async handlers MUST be wrapped in `asyncHandler`.
 *   - Never call `res.json` directly; use `ApiResponse.<verb>(res, ...)`.
 *   - Handlers never touch repositories; the service layer does that.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import adminAuthController from '../modules/iam/auth/auth.controller.js';
import adminPasswordController from '../modules/iam/auth/password.controller.js';
import mfaController from '../modules/iam/auth/mfa.controller.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.send(res, 501, null, `${op} is not implemented yet (Sprint 2 admin-management placeholder)`);
  });

// /admin-auth (real handlers from the auth module)
export const adminLogin = adminAuthController.login;
export const adminRefresh = adminAuthController.refresh;
export const adminLogout = adminAuthController.logout;
export const adminForgotPassword = adminPasswordController.forgotPassword;
export const adminResetPassword = adminPasswordController.resetPassword;
export const adminMfaEnroll = mfaController.enroll;
export const adminMfaVerify = mfaController.verifyEnrollment;
export const adminMe = adminAuthController.me;

// /admin (admin management - Sprint 2)
export const listAdmins = notImplemented('GET /admin/admins');
export const createAdmin = notImplemented('POST /admin/admins');
export const getAdmin = notImplemented('GET /admin/admins/:id');
export const updateAdmin = notImplemented('PATCH /admin/admins/:id');
export const suspendAdmin = notImplemented('POST /admin/admins/:id/suspend');
export const restoreAdmin = notImplemented('POST /admin/admins/:id/restore');
export const assignAdminRole = notImplemented('POST /admin/admins/:id/roles');
export const revokeAdminRole = notImplemented('DELETE /admin/admins/:id/roles/:roleId');
export const getAdminAudit = notImplemented('GET /admin/admins/:id/audit');

export default {
  adminLogin, adminRefresh, adminLogout, adminForgotPassword, adminResetPassword,
  adminMfaEnroll, adminMfaVerify, adminMe,
  listAdmins, createAdmin, getAdmin, updateAdmin, suspendAdmin, restoreAdmin,
  assignAdminRole, revokeAdminRole, getAdminAudit,
};
