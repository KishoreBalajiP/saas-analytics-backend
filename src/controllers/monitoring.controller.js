/**
 * Monitoring Controller (Sprint 8 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/monitoring`. Read-only, admin-gated
 *   probes of every subsystem we own.
 *
 * RESPONSIBILITY
 *   - getSystemHealth, getDbHealth, getWsHealth, getQueueHealth,
 *     getSchedulerHealth, getStorageHealth, getConnectorHealth,
 *     getAggregateHealth, getMetrics
 *
 * CODING GUIDELINES
 *   - Each live probe is time-boxed to 2 s by the service layer; failures
 *     degrade gracefully (structured result, never a 500).
 *   - `/health/aggregate` is cached for 5 seconds.
 *   - `/metrics` (Phase 4+) returns a structured deferred payload.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import * as monitoringService from '../services/monitoring.service.js';

/** GET /monitoring/health/system */
export const getSystemHealth = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getSystemHealth();
  return ApiResponse.ok(res, data, 'System health');
});

/** GET /monitoring/health/db */
export const getDbHealth = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getDbHealth();
  return ApiResponse.ok(res, data, 'Database health');
});

/** GET /monitoring/health/websocket */
export const getWsHealth = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getWsHealth();
  return ApiResponse.ok(res, data, 'WebSocket health');
});

/** GET /monitoring/health/queue */
export const getQueueHealth = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getQueueHealth();
  return ApiResponse.ok(res, data, 'Queue health');
});

/** GET /monitoring/health/scheduler */
export const getSchedulerHealth = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getSchedulerHealth();
  return ApiResponse.ok(res, data, 'Scheduler health');
});

/** GET /monitoring/health/storage */
export const getStorageHealth = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getStorageHealth();
  return ApiResponse.ok(res, data, 'Storage health');
});

/** GET /monitoring/health/connectors */
export const getConnectorHealth = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getConnectorHealth();
  return ApiResponse.ok(res, data, 'Connector health');
});

/** GET /monitoring/health/aggregate */
export const getAggregateHealth = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getAggregateHealth();
  return ApiResponse.ok(res, data, 'Aggregate health');
});

/** GET /monitoring/metrics */
export const getMetrics = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getMetrics();
  return ApiResponse.ok(res, data, 'Metrics');
});

export default {
  getSystemHealth, getDbHealth, getWsHealth, getQueueHealth,
  getSchedulerHealth, getStorageHealth, getConnectorHealth,
  getAggregateHealth, getMetrics,
};
