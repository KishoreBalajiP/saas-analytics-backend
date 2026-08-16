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
 *   - GET /health/queue          - queue depth (Phase 3, deferred)
 *   - GET /health/scheduler      - jobs status (Phase 3, deferred)
 *   - GET /health/storage        - provider latency (Phase 3, deferred)
 *   - GET /health/connectors     - connector uptime (Phase 3, deferred)
 *   - GET /health/aggregate      - one-shot summary (5 s cached)
 *   - GET /metrics               - prometheus (Phase 4, deferred)
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('monitoring', 'view') -> handler
 *
 * HOW TO EXTEND
 *   A new probe is one service function + one route; never skips the RBAC
 *   gate (the module is `monitoring`, the action is `view`).
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import monitoringController from '../controllers/monitoring.controller.js';

const router = Router();

router.get('/health/system', adminAuth, permission('monitoring', 'view'), monitoringController.getSystemHealth);
router.get('/health/db', adminAuth, permission('monitoring', 'view'), monitoringController.getDbHealth);
router.get('/health/websocket', adminAuth, permission('monitoring', 'view'), monitoringController.getWsHealth);
router.get('/health/queue', adminAuth, permission('monitoring', 'view'), monitoringController.getQueueHealth);
router.get('/health/scheduler', adminAuth, permission('monitoring', 'view'), monitoringController.getSchedulerHealth);
router.get('/health/storage', adminAuth, permission('monitoring', 'view'), monitoringController.getStorageHealth);
router.get('/health/connectors', adminAuth, permission('monitoring', 'view'), monitoringController.getConnectorHealth);
router.get('/health/aggregate', adminAuth, permission('monitoring', 'view'), monitoringController.getAggregateHealth);
router.get('/metrics', adminAuth, permission('monitoring', 'view'), monitoringController.getMetrics);

export default router;
