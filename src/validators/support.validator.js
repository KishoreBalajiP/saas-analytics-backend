/**
 * Support Validators (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Declarative request-shape schemas for the `/api/v1/admin/support`
 *   surface, consumed by `validate(schema)` from `src/validators/index.js`.
 *
 * RESPONSIBILITY
 *   - impersonateSchema / stopImpersonationSchema
 *   - recoverSchema / revokeSessionsSchema
 *   - tenantLookupsSchema / broadcastSchema
 *
 * CODING GUIDELINES
 *   - Every privileged action requires an explicit `reason` (3..500 chars)
 *     - it lands verbatim in the audit trail and the access log.
 *   - Ids are kept deliberately loose (1..64) since both ObjectIds and
 *     prefixed references (`usr_..`, `ses_..`) are accepted by the services.
 */

/** Body for starting an impersonation session. */
export const impersonateSchema = {
  body: {
    targetUserId: { type: 'string', required: true, minLength: 1, maxLength: 64 },
    reason: { type: 'string', required: true, minLength: 3, maxLength: 500 },
    // support: optional ticket reference recorded with the session.
    ticket: { type: 'string', maxLength: 120 },
  },
  params: {},
  query: {},
};

/** Body for stopping an impersonation session. */
export const stopImpersonationSchema = {
  body: {
    sessionId: { type: 'string', required: true, minLength: 1, maxLength: 64 },
    reason: { type: 'string', required: true, minLength: 3, maxLength: 500 },
  },
  params: {},
  query: {},
};

/** Body for the admin-initiated account recovery (email reset). */
export const recoverSchema = {
  body: {
    userId: { type: 'string', required: true, minLength: 1, maxLength: 64 },
    reason: { type: 'string', required: true, minLength: 3, maxLength: 500 },
  },
  params: {},
  query: {},
};

/** Body for revoking every session a user owns. */
export const revokeSessionsSchema = {
  body: {
    userId: { type: 'string', required: true, minLength: 1, maxLength: 64 },
    reason: { type: 'string', required: true, minLength: 3, maxLength: 500 },
  },
  params: {},
  query: {},
};

/** Params for the tenant lookup endpoint (`:id` is the `ten_...` id). */
export const tenantLookupsSchema = {
  body: {},
  params: {
    id: { type: 'string', required: true, minLength: 1, maxLength: 64 },
  },
  query: {},
};

/** Body for the tenant-scoped in-app broadcast. */
export const broadcastSchema = {
  body: {
    tenantId: { type: 'string', required: true, minLength: 1, maxLength: 64 },
    title: { type: 'string', required: true, minLength: 1, maxLength: 120 },
    body: { type: 'string', maxLength: 2000 },
    type: { type: 'string', minLength: 1, maxLength: 40 },
    reason: { type: 'string', required: true, minLength: 3, maxLength: 500 },
  },
  params: {},
  query: {},
};

/* ---------------- support: access redesign (roadmap 2.3) ----------------- */

const PAGE_RULES = {
  page: { type: 'integer', min: 1, max: 10000 },
  limit: { type: 'integer', min: 1, max: 100 },
};

/** Params for the sanitised tenant diagnostics endpoint. */
export const diagnosticsSchema = {
  body: {},
  params: {
    id: { type: 'string', required: true, minLength: 1, maxLength: 64 },
  },
  query: {},
};

/** Query for the support access grant listing. */
export const listGrantsSchema = {
  body: {},
  params: {},
  query: {
    tenantId: { type: 'string', minLength: 1, maxLength: 64 },
    status: { type: 'string', oneOf: ['pending', 'active', 'denied', 'revoked'] },
    kind: { type: 'string', oneOf: ['consent', 'break_glass'] },
    ...PAGE_RULES,
  },
};

/** Body for a break-glass request (incident access without consent). */
export const breakGlassRequestSchema = {
  body: {
    tenantId: { type: 'string', required: true, minLength: 1, maxLength: 64 },
    reason: { type: 'string', required: true, minLength: 10, maxLength: 500 },
    ticket: { type: 'string', maxLength: 120 },
  },
  params: {},
  query: {},
};

/** Approve / deny / revoke a grant: `:id` plus a reason. */
export const grantDecisionSchema = {
  body: {
    reason: { type: 'string', required: true, minLength: 3, maxLength: 500 },
  },
  params: {
    id: { type: 'string', required: true, minLength: 1, maxLength: 64 },
  },
  query: {},
};

/** Query for the support session listing. */
export const listImpersonationsSchema = {
  body: {},
  params: {},
  query: {
    tenantId: { type: 'string', minLength: 1, maxLength: 64 },
    status: { type: 'string', oneOf: ['active', 'ended'] },
    mine: { type: 'boolean' },
    ...PAGE_RULES,
  },
};

export default {
  impersonateSchema,
  stopImpersonationSchema,
  recoverSchema,
  revokeSessionsSchema,
  tenantLookupsSchema,
  broadcastSchema,
  // support:
  diagnosticsSchema,
  listGrantsSchema,
  breakGlassRequestSchema,
  grantDecisionSchema,
  listImpersonationsSchema,
  _meta: { phase: '8 - implemented' },
};
