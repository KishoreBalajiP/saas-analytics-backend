/**
 * /api/v1/dashboards routes - Interactive dashboard CRUD + sharing.
 *
 * WHY IT EXISTS
 *   Dashboards are versioned, tenant-scoped, shareable views of
 *   analytics data. Every save makes a new version. Reads cache by
 *   `(tenantId, dashboardId, version)`. Backed by `analytics/dashboards/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET    /                       - list (tenant-scoped)
 *   - POST   /                       - create
 *   - GET    /:id                    - detail (latest or specific version)
 *   - PATCH  /:id                    - update (creates a new version)
 *   - POST   /:id/publish            - publish a version
 *   - POST   /:id/share              - add share entry
 *   - DELETE /:id/share/:entryId     - revoke share
 *   - DELETE /:id                    - soft-delete
 *
 * HOW TO EXTEND
 *   - All routes pass through `tenantIsolation.middleware.js`.
 *   - Sharing delegates RBAC to `iam/permissions/` (no custom ACL).
 *   - WebSocket room: `analytics:<tenantId>:dashboard:<id>`.
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
      hint: 'See src/modules/analytics/dashboards/README.md',
    });
  });

router.get('/', notImplemented('GET /dashboards'));
router.post('/', notImplemented('POST /dashboards'));
router.get('/:id', notImplemented('GET /dashboards/:id'));
router.patch('/:id', notImplemented('PATCH /dashboards/:id'));
router.post('/:id/publish', notImplemented('POST /dashboards/:id/publish'));
router.post('/:id/share', notImplemented('POST /dashboards/:id/share'));
router.delete('/:id/share/:entryId', notImplemented('DELETE /dashboards/:id/share/:entryId'));
router.delete('/:id', notImplemented('DELETE /dashboards/:id'));

export default router;
