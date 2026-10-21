/**
 * Admin Validators (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Declarative request-shape schemas consumed by `validate(schema)` from
 *   `src/validators/index.js`. Auth schemas shipped in Sprint 1; the CRUD,
 *   lifecycle and role-grant schemas land here in Sprint 2.
 *
 * RESPONSIBILITY
 *   - loginSchema / refreshSchema / logoutSchema - admin auth surface
 *   - forgotPasswordSchema / resetPasswordSchema - admin password flow
 *   - mfaEnrollSchema / mfaVerifySchema          - admin MFA flow
 *   - createAdminSchema / updateAdminSchema      - `/admin/admins` CRUD
 *   - suspendSchema / restoreSchema              - lifecycle transitions
 *   - assignRoleSchema / revokeRoleSchema        - AdminRole grants
 *   - adminauth (roadmap 2.2): stepUpSchema, mfaDisableSchema (code OR
 *     recovery code), invitation preview/accept/resend/revoke/list schemas,
 *     credentialResetSchema; `createAdminSchema` no longer takes a password
 *     (admins are invited and choose their own).
 *
 * CODING GUIDELINES
 *   - `adminType` and statuses are validated against the model's canonical
 *     enums (`models/Admin.js`) so the validator and the service never drift.
 *   - `tenantScope` is an optional escalation scope for `support` admins;
 *     omitting it (or passing `null`) means the platform scope.
 *   - All required fields MUST be enumerated; never permissive defaults.
 */

import { ADMIN_TYPES } from '../models/Admin.js';

/** Six-digit TOTP code. Optional on login (only required when MFA is on). */
const mfaToken = { type: 'string', minLength: 6, maxLength: 6, pattern: '^\\d{6}$' };

/**
 * adminauth: a one-time recovery code as typed (16 symbols, case, spaces and
 * dashes ignored by the service). Accepted wherever a TOTP code is.
 */
const recoveryCode = { type: 'string', minLength: 16, maxLength: 40, pattern: '^[A-Za-z0-9 -]+$' };

/** adminauth: new password chosen by the admin (invitation, reset). */
const newPassword = { type: 'string', required: true, minLength: 8, maxLength: 256 };

/** adminauth: opaque emailed token (invitation). */
const emailedToken = { type: 'string', required: true, minLength: 20, maxLength: 200 };

/** @type {import('../index.js').Schema} */
export const loginSchema = {
  body: {
    email: 'email|required',
    password: 'string|required',
    mfaToken,
    recoveryCode,
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const refreshSchema = {
  // The refresh token is accepted from the HttpOnly cookie only; any body
  // field is dropped by the validator and never read.
  body: {},
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const logoutSchema = {
  // Logout reads the HttpOnly cookie and/or the bearer access token.
  body: {},
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const forgotPasswordSchema = {
  body: {
    email: 'email|required',
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const resetPasswordSchema = {
  body: {
    token: 'string|required',
    newPassword: { type: 'string', required: true, minLength: 8 },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const mfaEnrollSchema = {
  body: {},
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const mfaVerifySchema = {
  body: {
    code: { ...mfaToken, required: true },
  },
  params: {},
  query: {},
};

/**
 * POST /admin-auth/mfa/disable - step-up: the current password AND a
 * current TOTP code (or an unused recovery code) are required to turn MFA
 * off. The service refuses a request that carries neither code.
 * @type {import('../index.js').Schema}
 */
export const mfaDisableSchema = {
  body: {
    password: 'string|required',
    code: { type: 'string', pattern: '^\\d{6}$' },
    recoveryCode,
  },
  params: {},
  query: {},
};

/**
 * adminauth: POST /admin-auth/step-up - re-authenticate (password plus a
 * current TOTP code or an unused recovery code) to open a short step-up
 * window on the current session.
 * @type {import('../index.js').Schema}
 */
export const stepUpSchema = {
  body: {
    password: 'string|required',
    code: { type: 'string', pattern: '^\\d{6}$' },
    recoveryCode,
  },
  params: {},
  query: {},
};

/**
 * POST /admin/admins - invite a platform admin (adminauth). No password:
 * the invitee chooses one when accepting the emailed invitation.
 * @type {import('../index.js').Schema}
 */
export const createAdminSchema = {
  body: {
    email: 'email|required',
    name: { type: 'string', maxLength: 80 },
    adminType: { type: 'string', oneOf: [...ADMIN_TYPES] },
    tenantScope: { type: 'string', minLength: 1 },
  },
  params: {},
  query: {},
};

/** adminauth: POST /admin-auth/invitations/preview. @type {import('../index.js').Schema} */
export const invitationPreviewSchema = {
  body: { token: emailedToken },
  params: {},
  query: {},
};

/** adminauth: POST /admin-auth/invitations/accept. @type {import('../index.js').Schema} */
export const invitationAcceptSchema = {
  body: {
    token: emailedToken,
    password: newPassword,
    name: { type: 'string', maxLength: 80 },
  },
  params: {},
  query: {},
};

/** adminauth: resend / revoke a pending invitation. @type {import('../index.js').Schema} */
export const invitationActionSchema = {
  body: {
    reason: { type: 'string', maxLength: 500 },
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** adminauth: GET /admin/admins/invitations. @type {import('../index.js').Schema} */
export const invitationListSchema = {
  body: {},
  params: {},
  query: {
    status: { type: 'string', oneOf: ['pending', 'accepted', 'revoked', 'expired'] },
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

/**
 * adminauth: POST /admin/admins/:id/mfa/reset and /password/reset - an
 * admin-assisted credential reset. A reason is required for the audit trail.
 * @type {import('../index.js').Schema}
 */
export const credentialResetSchema = {
  body: {
    reason: { type: 'string', required: true, minLength: 3, maxLength: 500 },
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const updateAdminSchema = {
  body: {
    name: { type: 'string', maxLength: 80 },
    adminType: { type: 'string', oneOf: [...ADMIN_TYPES] },
    tenantScope: { type: 'string', minLength: 1 },
    locale: { type: 'string', minLength: 2, maxLength: 16 },
    timezone: { type: 'string', minLength: 1, maxLength: 64 },
    avatarUrl: { type: 'url' },
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const suspendSchema = {
  body: {
    reason: { type: 'string', maxLength: 500 },
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const restoreSchema = {
  body: {
    reason: { type: 'string', maxLength: 500 },
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const assignRoleSchema = {
  body: {
    roleId: 'objectId|required',
    tenantId: { type: 'string', minLength: 1 },
    expiresAt: { type: 'date' },
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const revokeRoleSchema = {
  body: {},
  query: {
    tenantId: { type: 'string', minLength: 1 },
  },
  params: {
    id: 'objectId|required',
    roleId: 'objectId|required',
  },
};

/** @type {import('../index.js').Schema} */
export const listSchema = {
  body: {},
  params: {},
  query: {
    status: { type: 'string', oneOf: ['pending', 'active', 'suspended', 'locked'] },
    adminType: { type: 'string', oneOf: [...ADMIN_TYPES] },
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

export default {
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  mfaEnrollSchema,
  mfaVerifySchema,
  mfaDisableSchema,
  stepUpSchema,
  createAdminSchema,
  invitationPreviewSchema,
  invitationAcceptSchema,
  invitationActionSchema,
  invitationListSchema,
  credentialResetSchema,
  updateAdminSchema,
  suspendSchema,
  restoreSchema,
  assignRoleSchema,
  revokeRoleSchema,
  listSchema,
  _meta: { phase: '2 - implemented' },
};
