/**
 * Monitoring Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/monitoring`. Read-only, admin-gated
 *   probes of every subsystem.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - getSystemHealth, getDbHealth, getWsHealth, getQueueHealth,
 *     getSchedulerHealth, getStorageHealth, getConnectorHealth,
 *     getAggregateHealth, getMetrics
 *
 * CODING GUIDELINES
 *   - Each probe has a 2-second timeout; service layer normalises errors.
 *   - `/health/aggregate` is cached for 5 seconds via `src/cache/`.
 *   - `/metrics` (Phase 4+) returns prometheus exposition format.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

export const getSystemHealth = notImplemented('GET /monitoring/health/system');
export const getDbHealth = notImplemented('GET /monitoring/health/db');
export const getWsHealth = notImplemented('GET /monitoring/health/websocket');
export const getQueueHealth = notImplemented('GET /monitoring/health/queue');
export const getSchedulerHealth = notImplemented('GET /monitoring/health/scheduler');
export const getStorageHealth = notImplemented('GET /monitoring/health/storage');
export const getConnectorHealth = notImplemented('GET /monitoring/health/connectors');
export const getAggregateHealth = notImplemented('GET /monitoring/health/aggregate');
export const getMetrics = notImplemented('GET /monitoring/metrics');

export default {
  getSystemHealth, getDbHealth, getWsHealth, getQueueHealth,
  getSchedulerHealth, getStorageHealth, getConnectorHealth,
  getAggregateHealth, getMetrics,
};
