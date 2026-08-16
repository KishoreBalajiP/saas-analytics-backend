/**
 * Audit Validators (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Declarative request-shape schemas for the `/audit-logs` surface,
 *   consumed by `validate(schema)` from `src/validators/index.js`.
 *
 * RESPONSIBILITY
 *   - listSchema      - query filters for GET /audit-logs
 *   - exportSchema    - body filters + format for POST /audit-logs/export
 *   - exportStatusSchema - params for GET /audit-logs/export/:exportId
 *   - moduleSchema    - params for GET /audit-logs/modules/:module
 *
 * CODING GUIDELINES
 *   - Every filter is validated as a plain string; the service layer
 *     (`utils/auditFilters.js`) additionally coerces values to safe
 *     scalars, so objects/arrays/operators can never reach the query.
 */

const dateParam = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  custom: (value) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'must be a valid ISO date';
    return true;
  },
};

/** Query filters for the paginated trail read. */
export const listSchema = {
  body: {},
  params: {},
  query: {
    tenantId: { type: 'string', minLength: 1 },
    module: { type: 'string', minLength: 1 },
    action: { type: 'string', minLength: 1 },
    actorId: { type: 'string', minLength: 1 },
    actorType: { type: 'string', oneOf: ['admin', 'user', 'service', 'system'] },
    result: { type: 'string', oneOf: ['success', 'failure'] },
    resourceType: { type: 'string', minLength: 1 },
    resourceId: { type: 'string', minLength: 1 },
    dateFrom: dateParam,
    dateTo: dateParam,
    search: { type: 'string', minLength: 1, maxLength: 200 },
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

/** Body for the async export request. */
export const exportSchema = {
  body: {
    format: { type: 'string', oneOf: ['json', 'csv'] },
    filters: { type: 'object' },
  },
  params: {},
  query: {},
};

/** Params for the export status poll. */
export const exportStatusSchema = {
  body: {},
  params: {
    exportId: { type: 'string', minLength: 1 },
  },
  query: {},
};

/** Params for the per-module listing. */
export const moduleSchema = {
  body: {},
  params: {
    module: { type: 'string', minLength: 1 },
  },
  query: {
    tenantId: { type: 'string', minLength: 1 },
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

export default {
  listSchema,
  exportSchema,
  exportStatusSchema,
  moduleSchema,
  _meta: { phase: '8 - implemented' },
};
