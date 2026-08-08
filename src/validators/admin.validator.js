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

/** @type {import('../index.js').Schema} */
export const loginSchema = {
  body: {
    email: 'email|required',
    password: 'string|required',
    mfaToken,
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const refreshSchema = {
  body: {
    refreshToken: { type: 'string', minLength: 1 },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const logoutSchema = {
  body: {
    refreshToken: { type: 'string', minLength: 1 },
  },
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

/** @type {import('../index.js').Schema} */
export const createAdminSchema = {
  body: {
    email: 'email|required',
    password: { type: 'string', required: true, minLength: 8 },
    name: { type: 'string', maxLength: 80 },
    adminType: { type: 'string', oneOf: [...ADMIN_TYPES] },
    tenantScope: { type: 'string', minLength: 1 },
    status: { type: 'string', oneOf: ['pending', 'active'] },
  },
  params: {},
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
  params: {
    id: 'objectId|required',
    roleId: 'objectId|required',
  },
  query: {},
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
  createAdminSchema,
  updateAdminSchema,
  suspendSchema,
  restoreSchema,
  assignRoleSchema,
  revokeRoleSchema,
  listSchema,
  _meta: { phase: '2 - implemented' },
};
