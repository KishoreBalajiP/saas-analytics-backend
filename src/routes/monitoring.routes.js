/**
 * /api/v1/monitoring routes - Operational health probes (Sprint 8 - implemented).
 *
 * WHY IT EXISTS
 *   Read-only, admin-gated snapshots of every subsystem we own. The
 *   service layer owns the probes (2 s time-box, graceful degradation);
 *   this file only declares the surface and its RBAC gate.
 *
 * ENDPOINTS
 *   - GET /health/system         - process / event loop
 *   - GET /health/db             - mongo ping
 *   - GET /health/websocket      - socket stats
 *   - GET /health/queue          - per-queue counts + transport/role
 *   - GET /health/scheduler      - jobs, last run/success/failure, overdue
 *   - GET /jobs/runs             - scheduled-job run history (paginated;
 *                                  filters: job, status)
 *   - GET /health/redis          - cache round trip (disabled without REDIS_URL)
 *   - GET /health/storage        - storage provider round trip
 *   - GET /health/smtp           - SMTP verify (disabled when mail is off)
 *   - GET /health/connectors     - platform-wide connector status counts
 *   - GET /health/aggregate      - one-shot summary (5 s cached; computed
 *                                  uncached when the cache is down)
 *   - GET /metrics               - JSON snapshot of the metrics registry
 *                                  (Prometheus text: GET /api/v1/metrics)
 *   - GET /health/mail           - mail transport + email outbox (2.7)
 *   - GET /outbox                - outbox messages, masked (filters:
 *                                  status, tenantId)
 *   - POST /outbox/:id/requeue   - retry a dead letter (monitoring.update)
 *   - GET /retention             - retention policies + last cleanup run
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('monitoring', 'view') -> adminScope.platform()
 *   -> handler (platform-wide health; tenant-scoped admins are refused)
 *
 * HOW TO EXTEND
 *   A new probe is one service function + one route; never skips the RBAC
 *   gate (the module is `monitoring`, the action is `view`).
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { adminScope } from '../middleware/adminScope.middleware.js';
import monitoringController from '../controllers/monitoring.controller.js';

const router = Router();

router.get('/health/system', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getSystemHealth);
router.get('/health/db', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getDbHealth);
router.get('/health/websocket', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getWsHealth);
router.get('/health/queue', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getQueueHealth);
router.get('/health/scheduler', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getSchedulerHealth);
router.get('/jobs/runs', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.listJobRuns);
router.get('/health/redis', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getRedisHealth);
router.get('/health/storage', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getStorageHealth);
router.get('/health/smtp', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getSmtpHealth);
router.get('/health/connectors', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getConnectorHealth);
router.get('/health/aggregate', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getAggregateHealth);
router.get('/metrics', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getMetrics);
// retention: mail/outbox health, outbox operations, retention surface (2.7).
// Mail health and retention status are platform-wide (tenant-scoped admins
// are refused). The outbox is per tenant: a scoped admin sees and requeues
// only its own tenant's messages, and naming another tenant is refused.
router.get('/health/mail', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getMailHealth);
router.get('/outbox', adminAuth, permission('monitoring', 'view'), adminScope.filtered(), monitoringController.listOutbox);
router.post('/outbox/:id/requeue', adminAuth, permission('monitoring', 'update'), adminScope.filtered(), monitoringController.requeueOutboxMessage);
router.get('/retention', adminAuth, permission('monitoring', 'view'), adminScope.platform(), monitoringController.getRetentionStatus);

export default router;
