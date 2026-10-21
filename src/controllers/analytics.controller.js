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
 *   - getExport        GET  /exports/:id           (export status)
 *   - downloadExport   GET  /exports/:id/download  (signed URL)
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
import { parseQueryString } from '../validators/analytics.validator.js';

const actorOf = (req) => req.user?.id ?? req.admin?.id ?? null;

/** GET /api/v1/analytics - run (or serve a cached) analytics query. */
export const queryRows = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');

  // Strict: unknown parameters and malformed JSON are 400 INVALID_QUERY;
  // the engine contract then validates every part of the query.
  const query = parseQueryString(req.query);
  const result = await analyticsService.query({ tenantId, actorId: actorOf(req), ...query });

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
      timezone: result.timezone,
      window: result.window,
      queryId: result.queryId,
      cacheKey: result.cacheKey,
      // ai-catalogue: the comparison window of a compared query.
      ...(result.compare ? { compare: result.compare } : {}),
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
  const kind = req.validated?.query?.kind;
  const result = await analyticsService.listQueries({ tenantId, page, limit, status, kind });
  return ApiResponse.ok(res, result.docs, 'Query history', {
    total: result.total,
    page: result.page,
    pages: result.pages,
    limit: result.limit,
  });
});

/**
 * POST /api/v1/analytics/export - schedule an async export of the whole
 * result (202 { exportId, status: 'pending', format }). The raw body goes
 * through the same strict contract as a live query (pagination excepted:
 * an export always holds every row), so an export can never be scheduled
 * for a query that would be rejected.
 */
export const exportAsync = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const outcome = await analyticsService.scheduleExport({ tenantId, actorId: actorOf(req), body });
  return ApiResponse.accepted(res, outcome, 'Export scheduled');
});

/** GET /api/v1/analytics/exports/:id - status of one of the caller's exports. */
export const getExport = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  const status = await analyticsService.getExport({ tenantId, actorId: actorOf(req), exportId: req.params.id });
  return ApiResponse.ok(res, status, 'Export');
});

/** GET /api/v1/analytics/exports/:id/download - short-lived signed URL (409 until ready). */
export const downloadExport = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  const descriptor = await analyticsService.downloadExport({ tenantId, actorId: actorOf(req), exportId: req.params.id });
  return ApiResponse.ok(res, descriptor, 'Download');
});

export default {
  queryRows,
  getQuery,
  listQueries,
  exportAsync,
  getExport,
  downloadExport,
};
