/**
 * /api/v1/monitoring routes - Operational health probes.
 *
 * WHY IT EXISTS
 *   Read-only, admin-gated snapshots of every subsystem we own. The
 *   service layer asks the relevant adapter (websocket, queues, jobs,
 *   storage, connectors) for a status; nothing here mutates state. Backed
 *   by `platform/monitoring/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET /health/system           - process / event loop
 *   - GET /health/db               - mongo ping
 *   - GET /health/websocket        - socket stats
 *   - GET /health/queue            - queue depth + workers
 *   - GET /health/scheduler        - jobs status
 *   - GET /health/storage          - provider latency
 *   - GET /health/connectors       - connector uptime
 *   - GET /health/aggregate        - one-shot summary
 *   - GET /metrics                 - prometheus (Phase 4+)
 *
 * HOW TO EXTEND
 *   - Each probe has a 2-second timeout; on timeout, the probe returns
 *     `{ status: 'degraded', error: 'timeout' }` rather than throwing.
 *   - The aggregate endpoint is cached for 5 seconds.
 */

import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';

const router = Router();

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    res.status(501).json({
      success: false,
      statusCode: 501,
      message: `${op} is not implemented yet (Phase 1.2 architecture placeholder)`,
      hint: 'See src/modules/platform/monitoring/README.md',
    });
  });

router.get('/health/system', notImplemented('GET /monitoring/health/system'));
router.get('/health/db', notImplemented('GET /monitoring/health/db'));
router.get('/health/websocket', notImplemented('GET /monitoring/health/websocket'));
router.get('/health/queue', notImplemented('GET /monitoring/health/queue'));
router.get('/health/scheduler', notImplemented('GET /monitoring/health/scheduler'));
router.get('/health/storage', notImplemented('GET /monitoring/health/storage'));
router.get('/health/connectors', notImplemented('GET /monitoring/health/connectors'));
router.get('/health/aggregate', notImplemented('GET /monitoring/health/aggregate'));
router.get('/metrics', notImplemented('GET /monitoring/metrics'));

export default router;
