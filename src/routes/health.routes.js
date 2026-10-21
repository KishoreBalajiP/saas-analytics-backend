/**
 * Health check endpoints.
 *
 * WHY IT EXISTS
 *   Load balancers, orchestrators and uptime monitors need cheap probes with
 *   clear semantics (roadmap 2.8, findings ops.07, ops.05, ops2.02).
 *
 * RESPONSIBILITY
 *   GET /api/v1/health -> LIVENESS. `{ status, uptime, timestamp,
 *   environment, version, db }`. Always 200 while the process runs and does
 *   no dependency I/O. A web instance whose database connection failed at
 *   boot keeps reconnecting in the background (config/database.js), so a
 *   liveness restart is never needed to recover.
 *
 *   GET /api/v1/health/ready -> READINESS (point the platform health check
 *   and the uptime monitor here). Evaluated by `services/readiness.service.js`:
 *     200 `status: 'ready'`     every dependency is fine;
 *     200 `status: 'degraded'`  a non-critical dependency (storage, the
 *                               scheduler heartbeat, SMTP) is failing;
 *     503 `status: 'not_ready'` MongoDB, Redis (when configured) or the
 *                               job queue transport is down.
 *   Both bodies carry `checks` (component -> ok | degraded | down |
 *   disabled | unknown) and nothing internal (no hosts, errors, latencies).
 *
 * HOW TO EXTEND
 *   Add a dependency check to `readiness.service.js`; never do expensive
 *   work here - probes hit it constantly.
 */

import { Router } from 'express';
import env from '../config/env.js';
import { isDatabaseConnected } from '../config/database.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { formatUptime } from '../utils/date.js';
import { readiness } from '../services/readiness.service.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const data = {
      status: 'ok',
      uptime: formatUptime(),
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
      environment: env.app.env,
      version: env.app.version,
      db: isDatabaseConnected() ? 'connected' : 'disconnected',
    };

    return ApiResponse.ok(res, data, 'Service is healthy');
  }),
);

router.get(
  '/ready',
  asyncHandler(async (req, res) => {
    const result = await readiness.check();
    const data = {
      status: result.status,
      timestamp: result.checkedAt,
      version: env.app.version,
      checks: result.checks,
    };
    // Never cached by intermediaries: every probe must see live state.
    res.setHeader('Cache-Control', 'no-store');
    if (result.status === 'not_ready') {
      const down = Object.entries(result.checks)
        .filter(([, status]) => status === 'down')
        .map(([name]) => name);
      return res.status(503).json({
        success: false,
        statusCode: 503,
        message: `Service is not ready: ${down.join(', ')} unavailable`,
        code: 'SERVICE_UNAVAILABLE',
        data,
        requestId: req.id,
        timestamp: data.timestamp,
      });
    }
    return ApiResponse.ok(res, data, result.status === 'degraded' ? 'Service is degraded' : 'Service is ready');
  }),
);

export default router;
