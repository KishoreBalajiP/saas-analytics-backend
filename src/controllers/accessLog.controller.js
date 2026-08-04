/**
 * Access Log Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/access-logs`. Per-request HTTP trace,
 *   higher cardinality than audit logs.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listAccessLogs, getTopPaths, getTopErrors, requestExport
 *
 * CODING GUIDELINES
 *   - Tenant Admins can only see their tenant's access logs.
 *   - Time-range filters are mandatory on aggregates.
 *   - Aggregation endpoints cache aggressively (60s TTL).
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

export const listAccessLogs = notImplemented('GET /access-logs');
export const getTopPaths = notImplemented('GET /access-logs/top-paths');
export const getTopErrors = notImplemented('GET /access-logs/top-errors');
export const requestExport = notImplemented('POST /access-logs/export');

export default {
  listAccessLogs, getTopPaths, getTopErrors, requestExport,
};
