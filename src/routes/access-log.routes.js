/**
 * /api/v1/access-logs routes - Per-request HTTP trace.
 *
 * WHY IT EXISTS
 *   Higher cardinality than audit logs: every authenticated HTTP request.
 *   Used for behaviour analytics, debugging, abuse detection. Writes
 *   come from `accessLog.middleware.js`. Backed by `governance/access-logs/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET    /                      - filter + paginate
 *   - GET    /top-paths             - aggregated top paths
 *   - GET    /top-errors            - aggregated error rates
 *   - POST   /export                - export to presigned URL
 *
 * HOW TO EXTEND
 *   - Admin-only. Tenant Admins see only their tenant.
 *   - Aggregation endpoints use the same time-range filters; cache
 *     aggressively (60s TTL on aggregates).
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
      hint: 'See src/modules/governance/access-logs/README.md',
    });
  });

router.get('/', notImplemented('GET /access-logs'));
router.get('/top-paths', notImplemented('GET /access-logs/top-paths'));
router.get('/top-errors', notImplemented('GET /access-logs/top-errors'));
router.post('/export', notImplemented('POST /access-logs/export'));

export default router;
