/**
 * /api/v1/reports routes - Scheduled + ad-hoc analytics reports.
 *
 * WHY IT EXISTS
 *   Reports produce frozen artefacts (CSV/XLSX/PDF) delivered via email
 *   or download. Parameters are persisted with each run so audits can
 *   reconstruct what the user saw. Backed by `analytics/reports/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET    /                       - list (tenant-scoped)
 *   - POST   /                       - create
 *   - GET    /:id                    - detail + latest run status
 *   - PATCH  /:id                    - update parameters / schedule
 *   - POST   /:id/run                - ad-hoc run (queued)
 *   - DELETE /:id                    - soft-delete
 *   - GET    /:id/download           - latest presigned URL
 *
 * HOW TO EXTEND
 *   - Runs always go through `src/queues/analytics.queue.js`.
 *   - Result artefacts live in `src/storage/`, not in MongoDB.
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
      hint: 'See src/modules/analytics/reports/README.md',
    });
  });

router.get('/', notImplemented('GET /reports'));
router.post('/', notImplemented('POST /reports'));
router.get('/:id', notImplemented('GET /reports/:id'));
router.patch('/:id', notImplemented('PATCH /reports/:id'));
router.post('/:id/run', notImplemented('POST /reports/:id/run'));
router.delete('/:id', notImplemented('DELETE /reports/:id'));
router.get('/:id/download', notImplemented('GET /reports/:id/download'));

export default router;
