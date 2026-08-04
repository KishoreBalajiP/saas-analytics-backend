/**
 * /api/v1/audit-logs routes - Read-only audit trail.
 *
 * WHY IT EXISTS
 *   Compliance + customer support depend on a searchable audit trail.
 *   Writes happen via `audit.middleware.js` (or directly from services
 *   that need to emit domain events). Reads happen here. Backed by
 *   `governance/audit-logs/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET    /                      - filter + paginate
 *   - GET    /:id                   - fetch one
 *   - POST   /export                - request an export (queued)
 *   - GET    /export/:exportId      - check status + presigned URL
 *   - GET    /modules/:module       - filter by module
 *
 * HOW TO EXTEND
 *   - All endpoints are admin-gated (`modulePermission('audit_logs', 'view')`).
 *   - Exports always flow through `src/queues/` -> `src/storage/` so the
 *     HTTP request never blocks.
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
      hint: 'See src/modules/governance/audit-logs/README.md',
    });
  });

router.get('/', notImplemented('GET /audit-logs'));
router.get('/:id', notImplemented('GET /audit-logs/:id'));
router.post('/export', notImplemented('POST /audit-logs/export'));
router.get('/export/:exportId', notImplemented('GET /audit-logs/export/:exportId'));
router.get('/modules/:module', notImplemented('GET /audit-logs/modules/:module'));

export default router;
