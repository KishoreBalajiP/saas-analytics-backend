/**
 * Analytics Validators (Sprint 5 - implemented).
 *
 * PURPOSE
 *   Declarative schemas for the `/api/v1/analytics` surface. Complex query
 *   parameters (`filters`, `groupBy`, `metrics`, ...) arrive on `GET` as
 *   JSON-encoded strings; `parseQueryString` turns them into the engine's
 *   query shape and rejects anything unknown. The contract itself (every
 *   rule and error code) lives in `services/analytics.engine.js`.
 *
 * RESPONSIBILITY
 *   - queryListSchema   - GET /queries?  (page, limit, status)
 *   - exportSchema      - POST /export   (shallow shape; contract checked in the service)
 *   - exportIdSchema    - GET /exports/:id[/download]
 *   - parseQueryString  - strict query-string -> query object (analytics + external API)
 *   - parsePagination   - shared default + clamp for page/limit
 */

import ApiError from '../utils/ApiError.js';
import { QUERY_ERROR_CODES } from '../services/analytics.engine.js';

/** Query-string parameters accepted by GET /analytics. */
export const ANALYTICS_QUERY_PARAMS = Object.freeze([
  'connectorIds', 'filters', 'filtersOp', 'dateRange', 'metrics', 'groupBy', 'orderBy', 'page', 'limit',
  // ai-catalogue: period-over-period comparison (JSON { type }).
  'compare',
]);
/** Query-string parameters accepted by GET /external/datasets/:id/query. */
export const EXTERNAL_QUERY_PARAMS = Object.freeze([
  'filters', 'filtersOp', 'dateRange', 'metrics', 'groupBy', 'orderBy', 'pagination',
]);
const JSON_PARAMS = new Set(['filters', 'dateRange', 'metrics', 'groupBy', 'orderBy', 'pagination', /* ai-catalogue: */ 'compare']);

/**
 * Parse a GET query string into the engine's query shape, strictly:
 * unknown parameters, repeated parameters and malformed JSON are 400
 * INVALID_QUERY with one field error each (nothing is silently ignored).
 * `page` / `limit` become `pagination`; `connectorIds` is comma-separated.
 *
 * @param {object} raw - `req.query`
 * @param {readonly string[]} [allowed]
 * @returns {object} query (validated further by the engine)
 */
export function parseQueryString(raw = {}, allowed = ANALYTICS_QUERY_PARAMS) {
  const errors = [];
  const query = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (!allowed.includes(key)) { errors.push({ field: key, message: 'is not a recognised query parameter' }); continue; }
    if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
      errors.push({ field: key, message: 'must be given once, as a single value' });
      continue;
    }
    if (value === undefined || value === '') continue;
    const text = String(value);
    if (JSON_PARAMS.has(key)) {
      try {
        query[key] = JSON.parse(text);
      } catch {
        errors.push({ field: key, message: 'must be valid JSON' });
      }
    } else if (key === 'connectorIds') {
      query.connectorIds = text.split(',').map((id) => id.trim()).filter(Boolean);
    } else if (key === 'page' || key === 'limit') {
      query.pagination = { ...(query.pagination || {}), [key]: text };
    } else {
      query[key] = text;
    }
  }
  if (errors.length) {
    throw new ApiError(400, 'Invalid analytics query', { code: QUERY_ERROR_CODES.INVALID_QUERY, errors });
  }
  return query;
}

export const QUERY_STATUSES = ['draft', 'pending', 'running', 'ready', 'failed'];

export const queryListSchema = {
  query: {
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
    status: { type: 'string', oneOf: QUERY_STATUSES },
    // ai-catalogue: `run` lists the attribution records of widget/report/alert/AI runs.
    kind: { type: 'string', oneOf: ['query', 'export', 'run'] },
  },
};

export const exportSchema = {
  body: {
    format: { type: 'string', oneOf: ['json', 'csv', 'xlsx'] },
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

export const exportIdSchema = {
  params: { id: 'objectId|required' },
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
  exportIdSchema,
  parseQueryString,
  parsePagination,
  Pagination,
  ANALYTICS_QUERY_PARAMS,
  EXTERNAL_QUERY_PARAMS,
};
