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
 *   - refreshSchema         { refreshToken? } (token normally via cookie)
 *   - logoutSchema          { refreshToken? } (token normally via cookie)
 *   - forgotPasswordSchema  { email }
 *   - resetPasswordSchema   { token, newPassword }
 *   - mfaVerifySchema       { code }
 *
 * CODING GUIDELINES
 *   - Schemas follow the engine's shorthand (`'string|required'`) or
 *     rules object (`{ type: 'string', required: true, minLength: 8 }`).
 *   - Validation lives here only. Controllers stay trivial.
 *   - All required fields MUST be enumerated; never permissive defaults.
 *   - Refresh/logout accept an optional body token because cookies can be
 *     disabled; the body is ignored when the cookie is present.
 *   - MFA codes are six digits (RFC 6238) and validated as STRINGS so a
 *     leading zero survives the round trip to the authenticator.
 */

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
export const mfaVerifySchema = {
  body: {
    code: { ...mfaToken, required: true },
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
  mfaVerifySchema,
  _meta: { sprint: '1 - auth validators implemented' },
};
