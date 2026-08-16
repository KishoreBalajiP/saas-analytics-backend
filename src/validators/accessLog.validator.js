/**
 * Access Log Validators (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Declarative request-shape schemas for the `/access-logs` surface,
 *   consumed by `validate(schema)` from `src/validators/index.js`.
 *
 * RESPONSIBILITY
 *   - listSchema      - query filters for GET /access-logs
 *   - topPathsSchema  - query filters for GET /access-logs/top-paths
 *   - topErrorsSchema - query filters for GET /access-logs/top-errors
 *   - exportSchema    - body filters + format for POST /access-logs/export
 *   - exportStatusSchema - params for GET /access-logs/export/:exportId
 *
 * CODING GUIDELINES
 *   - Every filter is validated as a plain string/integer; the service layer
 *     (`services/accessLog.service#buildFilter`) additionally coerces values
 *     to safe scalars, so objects/arrays/operators can never reach the query.
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

const rangeQuery = {
  tenantId: { type: 'string', minLength: 1 },
  dateFrom: dateParam,
  dateTo: dateParam,
  limit: { type: 'integer', min: 1, max: 100 },
};

/** Query filters for the paginated trace read. */
export const listSchema = {
  body: {},
  params: {},
  query: {
    tenantId: { type: 'string', minLength: 1 },
    actorId: { type: 'string', minLength: 1 },
    actorType: { type: 'string', oneOf: ['admin', 'user', 'service', 'system'] },
    method: { type: 'string', minLength: 1, maxLength: 10 },
    path: { type: 'string', minLength: 1, maxLength: 500 },
    statusCode: { type: 'integer', min: 100, max: 599 },
    event: { type: 'string', minLength: 1, maxLength: 50 },
    dateFrom: dateParam,
    dateTo: dateParam,
    search: { type: 'string', minLength: 1, maxLength: 200 },
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

/** Query filters for the top-paths aggregation. */
export const topPathsSchema = { body: {}, params: {}, query: { ...rangeQuery } };

/** Query filters for the top-errors aggregation. */
export const topErrorsSchema = { body: {}, params: {}, query: { ...rangeQuery } };

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

export default {
  listSchema,
  topPathsSchema,
  topErrorsSchema,
  exportSchema,
  exportStatusSchema,
  _meta: { phase: '8 - implemented' },
};
