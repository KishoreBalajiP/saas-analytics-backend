/**
 * Admin Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for the `/api/v1/admin` and `/api/v1/admin-auth`
 *   surface. Each handler:
 *     1. validates input via `src/validators/admin.validator.js`,
 *     2. delegates to `src/services/admin.service.js`,
 *     3. shapes the response envelope with `src/utils/ApiResponse.js`,
 *     4. surfaces failures via `src/utils/ApiError.js`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - /admin-auth: login, refresh, logout, password reset, MFA enroll/verify.
 *   - /admin: list, create, get, update, suspend, restore, role assign/
 *     revoke, audit-per-admin.
 *
 * CODING GUIDELINES
 *   - All async handlers MUST be wrapped in `asyncHandler`.
 *   - Never call `res.json` directly; use `ApiResponse.<verb>(res, ...)`.
 *   - Handlers never touch repositories; the service layer does that.
 *
 * FUTURE EXTENSION
 *   - Add `tenantFilter` query support for cross-tenant support admins.
 *   - Add structured `metadata` (pagination, totals) via ApiResponse.list.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

// /admin-auth
export const adminLogin = notImplemented('POST /admin-auth/login');
export const adminRefresh = notImplemented('POST /admin-auth/refresh');
export const adminLogout = notImplemented('POST /admin-auth/logout');
export const adminForgotPassword = notImplemented('POST /admin-auth/password/forgot');
export const adminResetPassword = notImplemented('POST /admin-auth/password/reset');
export const adminMfaEnroll = notImplemented('POST /admin-auth/mfa/enroll');
export const adminMfaVerify = notImplemented('POST /admin-auth/mfa/verify');
export const adminMe = notImplemented('GET /admin-auth/me');

// /admin (admin management)
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
