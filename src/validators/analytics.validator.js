/**
 * Analytics Validators (Sprint 5 - implemented).
 *
 * PURPOSE
 *   Declarative schemas for the `/api/v1/analytics` surface. Complex query
 *   parameters (`filters`, `groupBy`, `metrics`, ...) arrive on `GET` as
 *   JSON-encoded strings and are parsed/coerced by the controller; the
 *   `GET /queries` list and the `POST /export` body are validated here.
 *
 * RESPONSIBILITY
 *   - queryListSchema   - GET /queries?  (page, limit, status)
 *   - exportSchema      - POST /export   (rich JSON body)
 *   - parsePagination   - shared default + clamp for page/limit
 */

export const QUERY_STATUSES = ['draft', 'pending', 'running', 'ready', 'failed'];

export const queryListSchema = {
  query: {
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
    status: { type: 'string', oneOf: QUERY_STATUSES },
  },
};

export const exportSchema = {
  body: {
    connectorIds: { type: 'array' },
    filters: { type: 'array' },
    filtersOp: { type: 'string', oneOf: ['and', 'or'] },
    dateRange: { type: 'object' },
    metrics: { type: 'array' },
    groupBy: { type: 'array' },
    orderBy: { type: 'array' },
    pagination: { type: 'object' },
  },
};

export const Pagination = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 50,
  MAX_LIMIT: 200,
};

/**
 * Coerce raw page/limit inputs into safe integers within bounds.
 *
 * @param {{ page?: any, limit?: any }} input
 * @returns {{ page: number, limit: number }}
 */
export function parsePagination(input) {
  const page = Math.max(1, Number(input?.page) || Pagination.DEFAULT_PAGE);
  const limit = Math.min(Math.max(1, Number(input?.limit) || Pagination.DEFAULT_LIMIT), Pagination.MAX_LIMIT);
  return { page, limit };
}

export default {
  queryListSchema,
  exportSchema,
  parsePagination,
  Pagination,
};
