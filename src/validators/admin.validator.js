/**
 * Admin Validators (architecture placeholder).
 *
 * PURPOSE
 *   Declarative request-shape schemas consumed by `validate(schema)`
 *   from `src/validators/index.js`. Wired into route files via
 *   `router.post('/path', validate(adminValidator.create), handler)`.
 *
 * RESPONSIBILITY (planned, NO validation logic yet)
 *   - loginSchema         { email, password, mfaToken? }
 *   - refreshSchema       { refreshToken }
 *   - createAdminSchema   { email, adminType, profile }
 *   - updateAdminSchema   { adminType?, profile?, status? }
 *   - assignRoleSchema    { roleId, scope?, expiresAt? }
 *
 * CODING GUIDELINES
 *   - Schemas follow the engine's shorthand (`'string|required'`) or
 *     rules object (`{ type: 'string', required: true, minLength: 8 }`).
 *   - Validation lives here only. Controllers stay trivial.
 *   - All required fields MUST be enumerated; never permissive defaults.
 *
 * PHASE 1.2 STATUS
 *   No validation logic yet. Schemas are empty objects so the engine
 *   accepts any payload (`req.validated` will mirror inputs). Replace
 *   with the real rules when Phase 2 lands.
 */

/** @type {import('../index.js').Schema} */
export const loginSchema = {
  body: {},
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const refreshSchema = {
  body: {},
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const createAdminSchema = {
  body: {},
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const updateAdminSchema = {
  body: {},
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const assignRoleSchema = {
  body: {},
  params: {},
  query: {},
};

export default {
  loginSchema,
  refreshSchema,
  createAdminSchema,
  updateAdminSchema,
  assignRoleSchema,
  _meta: { phase: '1.2 - placeholder schemas' },
};
