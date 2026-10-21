/**
 * Auth Validators (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Declarative request-shape schemas consumed by `validate(schema)`
 *   from `src/validators/index.js`. Wired into route files via
 *   `router.post('/login', validate(authValidator.loginSchema), handler)`.
 *
 * RESPONSIBILITY
 *   - loginSchema           { email, password, mfaToken? }
 *   - refreshSchema         {} (refresh token via HttpOnly cookie only)
 *   - logoutSchema          {} (cookie and/or bearer access token)
 *   - forgotPasswordSchema  { email }
 *   - resetPasswordSchema   { token, newPassword }
 *   - mfaVerifySchema       { code }
 *
 * CODING GUIDELINES
 *   - Schemas follow the engine's shorthand (`'string|required'`) or
 *     rules object (`{ type: 'string', required: true, minLength: 8 }`).
 *   - Validation lives here only. Controllers stay trivial.
 *   - All required fields MUST be enumerated; never permissive defaults.
 *   - Refresh/logout never read a body token: the refresh credential is
 *     cookie-only so it is never exposed to page scripts or request logs.
 *   - MFA codes are six digits (RFC 6238) and validated as STRINGS so a
 *     leading zero survives the round trip to the authenticator.
 */

/** Six-digit TOTP code. Optional on login (only required when MFA is on). */
const mfaToken = { type: 'string', minLength: 6, maxLength: 6, pattern: '^\\d{6}$' };

/**
 * mfa-tenant: a one-time recovery code as typed (16 symbols; case, spaces
 * and dashes are ignored by `utils/recoveryCodes.js`).
 */
const recoveryCode = { type: 'string', minLength: 16, maxLength: 40, pattern: '^[A-Za-z0-9 -]+$' };

/** @type {import('../index.js').Schema} */
export const loginSchema = {
  body: {
    email: 'email|required',
    password: 'string|required',
    mfaToken,
    // mfa-tenant: accepted instead of `mfaToken`.
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
export const registerSchema = {
  body: {
    fullName: { type: 'string', required: true, minLength: 2, maxLength: 120 },
    email: 'email|required',
    password: { type: 'string', required: true, minLength: 8 },
    workspaceName: { type: 'string', required: true, minLength: 2, maxLength: 80 },
    workspaceSlug: { type: 'string', minLength: 2, maxLength: 50, pattern: '^[a-z0-9-]+$' },
    // onboarding: Terms/Privacy consent (must be true) and the shown version.
    acceptTerms: { type: 'boolean', required: true },
    termsVersion: { type: 'string', maxLength: 64 },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const verifyEmailSchema = {
  body: {
    token: 'string|required',
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const resendVerificationSchema = {
  body: {
    email: 'email|required',
  },
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

// mfa-tenant: tenant-user MFA self-service.

/**
 * POST /auth/mfa/disable - step-up inline: the current password AND a
 * current TOTP code (or an unused recovery code).
 * @type {import('../index.js').Schema}
 */
export const mfaDisableSchema = {
  body: {
    password: 'string|required',
    code: mfaToken,
    recoveryCode,
  },
  params: {},
  query: {},
};

/**
 * POST /auth/step-up - re-authenticate (password + current code or a
 * recovery code) to open a short step-up window on this session.
 * @type {import('../index.js').Schema}
 */
export const stepUpSchema = {
  body: {
    password: 'string|required',
    code: mfaToken,
    recoveryCode,
  },
  params: {},
  query: {},
};

export default {
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  registerSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  mfaVerifySchema,
  // mfa-tenant
  mfaDisableSchema,
  stepUpSchema,
  _meta: { sprint: '1 - auth validators implemented' },
};
