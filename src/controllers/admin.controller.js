/**
 * Admin Controller (Sprint 2 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for the `/api/v1/admin` and `/api/v1/admin-auth`
 *   surface.
 *
 * RESPONSIBILITY
 *   - /admin-auth handlers delegate to the real module controllers
 *     (`src/modules/iam/auth/`) - kept here as a compatibility alias so
 *     import paths documented in early phases keep working.
 *   - /admin handlers manage platform admins (list/create/detail/update),
 *     lifecycle transitions (suspend/restore) and AdminRole grants.
 *   - adminauth (roadmap 2.2): `createAdmin` now INVITES (no password in the
 *     body); invitation list/resend/revoke; admin-assisted MFA and password
 *     resets (super only, never oneself, step-up enforced by the route).
 *
 * CODING GUIDELINES
 *   - All async handlers MUST be wrapped in `asyncHandler`.
 *   - Never call `res.json` directly; use `ApiResponse.<verb>(res, ...)`.
 *   - Handlers never touch repositories; the service layer does that.
 *   - `by` attribution comes from the authenticated admin (never the body).
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import adminService from '../services/admin.service.js';
import adminCredentialsService from '../services/adminCredentials.service.js';
import auditLogService from '../services/auditLog.service.js';
import adminAuthController from '../modules/iam/auth/auth.controller.js';
import adminPasswordController from '../modules/iam/auth/password.controller.js';
import mfaController from '../modules/iam/auth/mfa.controller.js';

const actor = (req) => req.admin?.id ?? null;

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

/** GET /admin/admins - paginated admin list, filterable by status/type. */
export const listAdmins = asyncHandler(async (req, res) => {
  const { status, adminType, page, limit } = req.validated?.query ?? {};
  const result = await adminService.list({
    status,
    adminType,
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, result.docs, 'Admins fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/**
 * POST /admin/admins - invite a platform admin (adminauth). The admin is
 * created `pending` without a password and receives an acceptance link.
 * Response: the admin (secrets stripped) plus `invitation` and `delivered`.
 */
export const createAdmin = asyncHandler(async (req, res) => {
  const { email, name, adminType, tenantScope } = req.validated?.body ?? {};
  const { admin, invitation, delivered } = await adminService.invite({
    email,
    name,
    adminType,
    tenantScope,
    by: actor(req),
  });
  return ApiResponse.created(
    res,
    { ...admin, invitation, delivered },
    delivered ? 'Invitation sent' : 'Admin invited; the invitation email could not be delivered',
  );
});

/** GET /admin/admins/invitations - invitation history (adminauth). */
export const listAdminInvitations = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.validated?.query ?? {};
  const result = await adminService.listInvitations({ status, page: page ?? 1, limit: limit ?? 20 });
  return ApiResponse.ok(res, result.docs, 'Invitations fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** POST /admin/admins/:id/invitation/resend - new link, old one stops working. */
export const resendAdminInvitation = asyncHandler(async (req, res) => {
  const result = await adminService.resendInvitation({ id: req.params.id, by: actor(req) });
  return ApiResponse.ok(res, result, result.delivered ? 'Invitation sent' : 'Invitation renewed; the email could not be delivered');
});

/** POST /admin/admins/:id/invitation/revoke - revoke and remove the pending admin. */
export const revokeAdminInvitation = asyncHandler(async (req, res) => {
  const result = await adminService.revokeInvitation({
    id: req.params.id,
    by: actor(req),
    reason: req.validated?.body?.reason ?? null,
  });
  return ApiResponse.ok(res, result, 'Invitation revoked');
});

/** POST /admin/admins/:id/mfa/reset - admin-assisted MFA reset (adminauth). */
export const resetAdminMfa = asyncHandler(async (req, res) => {
  const result = await adminCredentialsService.resetMfa({
    adminId: req.params.id,
    by: actor(req),
    reason: req.validated.body.reason,
  });
  return ApiResponse.ok(res, result, 'MFA reset; the admin must enrol again at the next sign-in');
});

/** POST /admin/admins/:id/password/reset - admin-assisted password reset (adminauth). */
export const resetAdminPassword = asyncHandler(async (req, res) => {
  const result = await adminCredentialsService.resetPassword({
    adminId: req.params.id,
    by: actor(req),
    reason: req.validated.body.reason,
  });
  return ApiResponse.ok(
    res,
    result,
    result.delivered ? 'Password reset; a reset link was emailed to the admin' : 'Password reset; the reset email could not be delivered',
  );
});

/** GET /admin/admins/:id - detail (secrets stripped by the service). */
export const getAdmin = asyncHandler(async (req, res) => {
  const admin = await adminService.getById({ id: req.params.id });
  return ApiResponse.ok(res, admin, 'Admin fetched');
});

/** PATCH /admin/admins/:id - update profile / adminType / scope. */
export const updateAdmin = asyncHandler(async (req, res) => {
  const patch = { ...(req.validated?.body ?? {}) };
  // roles: `tenantScope: null` (or "") clears the scope, making the admin
  // platform-wide again; the validator drops empty values, so read it here.
  if (req.body && Object.hasOwn(req.body, 'tenantScope') && (req.body.tenantScope === null || req.body.tenantScope === '')) {
    patch.tenantScope = null;
  }
  const admin = await adminService.update({
    id: req.params.id,
    patch,
    by: actor(req),
  });
  return ApiResponse.ok(res, admin, 'Admin updated');
});

/** POST /admin/admins/:id/suspend - block login and revoke sessions. */
export const suspendAdmin = asyncHandler(async (req, res) => {
  const admin = await adminService.suspend({ id: req.params.id, by: actor(req) });
  return ApiResponse.ok(res, admin, 'Admin suspended');
});

/** POST /admin/admins/:id/restore - unblock a suspended admin. */
export const restoreAdmin = asyncHandler(async (req, res) => {
  const admin = await adminService.restore({ id: req.params.id, by: actor(req) });
  return ApiResponse.ok(res, admin, 'Admin restored');
});

/** POST /admin/admins/:id/roles - grant a role (optionally tenant-scoped). */
export const assignAdminRole = asyncHandler(async (req, res) => {
  const { roleId, tenantId, expiresAt } = req.validated?.body ?? {};
  const grant = await adminService.assignRole({
    adminId: req.params.id,
    roleId,
    tenantId: tenantId ?? null,
    expiresAt,
    by: actor(req),
  });
  return ApiResponse.ok(res, grant, grant.alreadyAssigned ? 'Role already assigned' : 'Role assigned');
});

/** DELETE /admin/admins/:id/roles/:roleId - revoke a role grant. */
export const revokeAdminRole = asyncHandler(async (req, res) => {
  const result = await adminService.revokeRole({
    adminId: req.params.id,
    roleId: req.params.roleId,
    // Tenant-scoped grants are revoked by passing their tenant id.
    tenantId: req.validated?.query?.tenantId ?? null,
    by: actor(req),
  });
  return ApiResponse.ok(res, result, 'Role revoked');
});

/** GET /admin/admins/:id/audit - audit trail scoped to the admin. */
export const getAdminAudit = asyncHandler(async (req, res) => {
  const { page, limit } = req.validated?.query ?? {};
  const result = await auditLogService.list({
    actorId: req.params.id,
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, result.docs, 'Admin audit fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

export default {
  adminLogin, adminRefresh, adminLogout, adminForgotPassword, adminResetPassword,
  adminMfaEnroll, adminMfaVerify, adminMe,
  listAdmins, createAdmin, getAdmin, updateAdmin, suspendAdmin, restoreAdmin,
  assignAdminRole, revokeAdminRole, getAdminAudit,
  // adminauth
  listAdminInvitations, resendAdminInvitation, revokeAdminInvitation,
  resetAdminMfa, resetAdminPassword,
};
