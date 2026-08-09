/**
 * Analytics Controller (Sprint 5 - implemented).
 *
 * PURPOSE
 *   HTTP layer for `/api/v1/analytics`. Translates request context (tenant,
 *   actor) and the *string* query-string parameters (including JSON-encoded
 *   `filters`, `groupBy`, `metrics`, ...) into the normalised objects the
 *   service expects, then shapes the envelope with `ApiResponse`.
 *
 * RESPONSIBILITY
 *   - queryRows        GET  /           (run a query)
 *   - listQueries      GET  /queries    (history)
 *   - getQuery         GET  /queries/:id
 *   - exportAsync      POST /export     (202 scheduled)
 *
 * CODING GUIDELINES
 *   - Reads `req.tenant.id` (set by resolveTenant before these run).
 *   - Complex params arrive as JSON strings on `GET`; parse + validate them
 *     here so the service/engine only ever handle typed objects.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import * as analyticsService from '../services/analytics.service.js';
import { parsePagination } from '../validators/analytics.validator.js';

const actorOf = (req) => req.user?.id ?? req.admin?.id ?? null;

/** Parse a JSON-encoded query parameter, returning `undefined` when absent. */
function parseJsonParam(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw ApiError.badRequest(`${field} must be a valid JSON string`);
  }
}

/** Parse a comma-separated id list, returning undefined when absent. */
function parseConnectorIds(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** GET /api/v1/analytics - run (or serve a cached) analytics query. */
export const queryRows = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');

  const { page, limit } = parsePagination(req.query);
  const filters = parseJsonParam(req.query.filters, 'filters');
  const dateRange = parseJsonParam(req.query.dateRange, 'dateRange');
  const groupBy = parseJsonParam(req.query.groupBy, 'groupBy');
  const metrics = parseJsonParam(req.query.metrics, 'metrics');
  const orderBy = parseJsonParam(req.query.orderBy, 'orderBy');
  const filtersOp = typeof req.query.filtersOp === 'string' ? String(req.query.filtersOp) : 'and';
  const connectorIds = parseConnectorIds(req.query.connectorIds);

  const result = await analyticsService.query({
    tenantId,
    connectorIds,
    filters,
    filtersOp,
    dateRange,
    metrics,
    groupBy,
    orderBy,
    pagination: { page, limit },
  });

  return ApiResponse.ok(
    res,
    result.rows,
    'Analytics query',
    {
      total: result.total,
      page: result.page,
      pages: result.pages,
      limit: result.limit,
      columns: result.columns,
      cached: result.cached,
      executedAt: result.executedAt,
      groupMode: result.groupMode,
      queryId: result.queryId,
      cacheKey: result.cacheKey,
    },
  );
});

/** GET /api/v1/analytics/queries/:id - fetch a historical run. */
export const getQuery = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  const query = await analyticsService.getQuery({ tenantId, id: req.params.id });
  return ApiResponse.ok(res, query, 'Analytics query');
});

/** GET /api/v1/analytics/queries - paginated run history. */
export const listQueries = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 20), 100);
  const status = req.query.status ? String(req.query.status) : undefined;
  const result = await analyticsService.listQueries({ tenantId, page, limit, status });
  return ApiResponse.ok(res, result.docs, 'Query history', {
    total: result.total,
    page: result.page,
    pages: result.pages,
    limit: result.limit,
  });
});

/** POST /api/v1/analytics/export - schedule an async export (202). */
export const exportAsync = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  const params = req.validated?.body ?? req.body ?? {};
  const outcome = await analyticsService.scheduleExport({ tenantId, actorId: actorOf(req), params });
  return ApiResponse.accepted(res, outcome, 'Export scheduled');
});

export default {
  queryRows,
  getQuery,
  listQueries,
  exportAsync,
};
