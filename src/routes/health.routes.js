/**
 * Health check endpoint.
 *
 * WHY IT EXISTS
 *   Load balancers, orchestrators and uptime monitors need a cheap, dependency-
 *   free probe. This route answers liveness (process is up) and readiness
 *   hints (database connectivity) in one response.
 *
 * RESPONSIBILITY
 *   GET /api/v1/health -> `{ status, uptime, timestamp, environment, version,
 *   db }`. Always 200 while the process runs; `db` reflects live connectivity
 *   so infra can decide to route traffic (or not).
 *
 * HOW TO EXTEND
 *   Add lightweight checks (redis, external deps) as they appear, but never
 *   do expensive work here - probes hit it constantly.
 */

import { Router } from 'express';
import env from '../config/env.js';
import { isDatabaseConnected } from '../config/database.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { formatUptime } from '../utils/date.js';

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

export default router;
