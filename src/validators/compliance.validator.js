/**
 * Compliance Validators (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Declarative request-shape schemas for the `/compliance` surface,
 *   consumed by `validate(schema)` from `src/validators/index.js`.
 *
 * RESPONSIBILITY
 *   - createSchema        - body for POST /compliance/requests
 *   - listSchema          - query filters for GET /compliance/requests
 *   - paramSchema         - params for request-scoped endpoints
 *   - cancelSchema        - body for POST /compliance/requests/:id/cancel
 *   - publicCreateSchema  - body for POST /compliance/public/requests
 *   - publicStatusSchema  - query token for GET /compliance/public/requests/:id
 *
 * CODING GUIDELINES
 *   - Values are coerced to plain scalars; the service layer additionally
 *     whitelists every filter, so objects/arrays/operators can never reach
 *     the query.
 */

const REQUEST_TYPES = ['export', 'delete', 'restrict', 'consent.withdraw'];
const SUBJECT_TYPES = ['user', 'tenant'];
const STATUSES = ['received', 'in_progress', 'completed', 'rejected', 'cancelled'];

/** Body for the admin "file on behalf of a subject" endpoint. */
export const createSchema = {
  body: {
    subjectId: { type: 'string', required: true, minLength: 1, maxLength: 64 },
    subjectType: { type: 'string', oneOf: SUBJECT_TYPES },
    type: { type: 'string', required: true, oneOf: REQUEST_TYPES },
    reason: { type: 'string', required: true, minLength: 3, maxLength: 2000 },
    subjectEmail: { type: 'string' },
    tenantScope: { type: 'array' },
  },
  params: {},
  query: {},
};

/** Query filters for the paginated list read. */
export const listSchema = {
  body: {},
  params: {},
  query: {
    type: { type: 'string', oneOf: REQUEST_TYPES },
    status: { type: 'string', oneOf: STATUSES },
    subjectId: { type: 'string', minLength: 1, maxLength: 64 },
    subjectType: { type: 'string', oneOf: SUBJECT_TYPES },
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

/** Params for request-scoped endpoints (`:id` is the `crq_...` reference). */
export const paramSchema = {
  body: {},
  params: {
    id: { type: 'string', required: true, minLength: 1, maxLength: 64 },
  },
  query: {},
};

/** Body for cancelling a request before work starts. */
export const cancelSchema = {
  body: {
    reason: { type: 'string', minLength: 3, maxLength: 2000 },
  },
  params: {
    id: { type: 'string', required: true, minLength: 1, maxLength: 64 },
  },
  query: {},
};

/** Body for the subject-facing filing endpoint (identity comes from JWT). */
export const publicCreateSchema = {
  body: {
    type: { type: 'string', required: true, oneOf: REQUEST_TYPES },
    reason: { type: 'string', required: true, minLength: 3, maxLength: 2000 },
  },
  params: {},
  query: {},
};

/** Query for the subject status poll (signed token). */
export const publicStatusSchema = {
  body: {},
  params: {
    id: { type: 'string', required: true, minLength: 1, maxLength: 64 },
  },
  query: {
    token: { type: 'string', required: true, minLength: 20, maxLength: 300 },
  },
};

export default {
  createSchema,
  listSchema,
  paramSchema,
  cancelSchema,
  publicCreateSchema,
  publicStatusSchema,
  _meta: { phase: '8 - implemented' },
};
