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

export default {
  impersonateSchema,
  stopImpersonationSchema,
  recoverSchema,
  revokeSessionsSchema,
  tenantLookupsSchema,
  broadcastSchema,
  _meta: { phase: '8 - implemented' },
};
