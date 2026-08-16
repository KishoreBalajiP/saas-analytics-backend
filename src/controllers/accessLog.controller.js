/**
 * Access Log Controller (Sprint 8 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/access-logs`. Per-request HTTP trace,
 *   higher cardinality than audit logs.
 *
 * RESPONSIBILITY
 *   - listAccessLogs, getTopPaths, getTopErrors, requestExport,
 *     getExportStatus
 *
 * CODING GUIDELINES
 *   - Admin-only access via `adminAuth` + permission middleware on the
 *     route layer.
 *   - Tenant Admins / tenant-scoped support admins can only see their own
 *     tenant (`req.admin.tenantId`); platform admins pass through.
 *   - Aggregation endpoints require an optional time range and are capped.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import accessLogService from '../services/accessLog.service.js';

/** Resolve the caller's tenant boundary (null = platform-wide). */
function boundary(req) {
  return req.admin?.tenantId ?? null;
}

/** GET /access-logs - filter + paginate the trace. */
export const listAccessLogs = asyncHandler(async (req, res) => {
  const {
    tenantId, actorId, actorType, method, path, statusCode, event,
    dateFrom, dateTo, search, page, limit,
  } = req.validated?.query ?? {};
  const data = await accessLogService.list({
    tenantId: boundary(req) ?? tenantId,
    filters: { actorId, actorType, method, path, statusCode, event, dateFrom, dateTo, search },
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, data.docs, 'Access entries fetched', {
    page: data.page,
    limit: data.limit,
    total: data.total,
    pages: data.pages,
  });
});

/** GET /access-logs/top-paths - aggregated top paths. */
export const getTopPaths = asyncHandler(async (req, res) => {
  const { tenantId, dateFrom, dateTo, limit } = req.validated?.query ?? {};
  const data = await accessLogService.getTopPaths({
    tenantId: boundary(req) ?? tenantId,
    filters: { dateFrom, dateTo },
    limit: limit ?? 10,
  });
  return ApiResponse.ok(res, data, 'Top paths');
});

/** GET /access-logs/top-errors - aggregated error rates. */
export const getTopErrors = asyncHandler(async (req, res) => {
  const { tenantId, dateFrom, dateTo, limit } = req.validated?.query ?? {};
  const data = await accessLogService.getTopErrors({
    tenantId: boundary(req) ?? tenantId,
    filters: { dateFrom, dateTo },
    limit: limit ?? 10,
  });
  return ApiResponse.ok(res, data, 'Top errors');
});

/** POST /access-logs/export - request an async export (JSON or CSV). */
export const requestExport = asyncHandler(async (req, res) => {
  const { format = 'json', filters = {} } = req.validated?.body ?? {};
  const exportJob = await accessLogService.requestExport({
    tenantId: boundary(req),
    requestedBy: req.admin?.id ?? null,
    filters,
    format,
  });
  return ApiResponse.accepted(res, exportJob, 'Access-log export requested');
});

/** GET /access-logs/export/:exportId - poll export status. */
export const getExportStatus = asyncHandler(async (req, res) => {
  const status = await accessLogService.getExportStatus({
    exportId: req.params.exportId,
    tenantId: boundary(req),
  });
  return ApiResponse.ok(res, status, 'Export status');
});

export default {
  listAccessLogs, getTopPaths, getTopErrors, requestExport, getExportStatus,
};
