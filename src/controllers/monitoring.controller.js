/**
 * Monitoring Controller (Sprint 8 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/monitoring`. Read-only, admin-gated
 *   probes of every subsystem we own.
 *
 * RESPONSIBILITY
 *   - getSystemHealth, getDbHealth, getWsHealth, getQueueHealth,
 *     getSchedulerHealth, getRedisHealth, getStorageHealth, getSmtpHealth,
 *     getConnectorHealth, getAggregateHealth, getMetrics, listJobRuns
 *   - getMailHealth, listOutbox, requeueOutboxMessage, getRetentionStatus
 *     (retention, roadmap 2.7)
 *
 * CODING GUIDELINES
 *   - Each live probe is time-boxed by the service layer; failures
 *     degrade gracefully (structured result, never a 500).
 *   - `/health/aggregate` is cached for 5 seconds.
 *   - `/metrics` returns the JSON snapshot of the metrics registry.
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

/** GET /monitoring/jobs/runs - paginated scheduled-job run history. */
export const listJobRuns = asyncHandler(async (req, res) => {
  const result = await monitoringService.listJobRuns({
    job: typeof req.query.job === 'string' ? req.query.job : undefined,
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    page: req.query.page,
    limit: req.query.limit,
  });
  return ApiResponse.ok(res, result.docs, 'Job runs', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** GET /monitoring/health/redis */
export const getRedisHealth = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getRedisHealth();
  return ApiResponse.ok(res, data, 'Redis health');
});

/** GET /monitoring/health/storage */
export const getStorageHealth = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getStorageHealth();
  return ApiResponse.ok(res, data, 'Storage health');
});

/** GET /monitoring/health/smtp */
export const getSmtpHealth = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getSmtpHealth();
  return ApiResponse.ok(res, data, 'SMTP health');
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

/* ---------------------- retention: mail + retention ---------------------- */

/** GET /monitoring/health/mail - mail transport + email outbox health. */
export const getMailHealth = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getMailHealth({ probe: true });
  return ApiResponse.ok(res, data, 'Mail health');
});

/** GET /monitoring/outbox - outbox messages (masked recipients). */
export const listOutbox = asyncHandler(async (req, res) => {
  const result = await monitoringService.listOutbox({
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    tenantId: typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined,
    scopeTenantId: req.admin?.tenantId ?? null,
    page: req.query.page,
    limit: req.query.limit,
  });
  return ApiResponse.ok(res, result.docs, 'Outbox messages', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** POST /monitoring/outbox/:id/requeue - retry a dead-lettered message. */
export const requeueOutboxMessage = asyncHandler(async (req, res) => {
  const data = await monitoringService.requeueOutboxMessage({
    id: req.params.id,
    actor: req.admin?.id ? { type: 'admin', id: String(req.admin.id) } : { type: 'system', id: null },
    scopeTenantId: req.admin?.tenantId ?? null,
  });
  return ApiResponse.ok(res, data, 'Message requeued');
});

/** GET /monitoring/retention - policies, legal holds, last cleanup run. */
export const getRetentionStatus = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getRetentionStatus();
  return ApiResponse.ok(res, data, 'Retention status');
});

/** GET /monitoring/metrics */
export const getMetrics = asyncHandler(async (_req, res) => {
  const data = await monitoringService.getMetrics();
  return ApiResponse.ok(res, data, 'Metrics');
});

export default {
  getSystemHealth, getDbHealth, getWsHealth, getQueueHealth,
  getSchedulerHealth, getRedisHealth, getStorageHealth, getSmtpHealth, getConnectorHealth,
  getAggregateHealth, getMetrics, listJobRuns,
  getMailHealth, listOutbox, requeueOutboxMessage, getRetentionStatus,
};
