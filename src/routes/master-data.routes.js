/**
 * /api/v1/master-data routes - Global catalogue (admin write/read) and a
 * separate cached read surface for the Tenant Portal / Mobile App / Embed.
 *
 * WHY IT EXISTS
 *   Master data (countries, currencies, plans, themes, ...) is the lookup
 *   catalogue every other module depends on. Centralising CRUD here means
 *   the catalogue has exactly one write surface and one cached read
 *   surface. Backed by `platform/master-data/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET    /:catalogue             - list (admin or tenant-cached read)
 *   - GET    /:catalogue/:id         - detail
 *   - POST   /:catalogue             - create
 *   - PATCH  /:catalogue/:id         - update (optimistic concurrency)
 *   - DELETE /:catalogue/:id         - delete (refuses if system-bound)
 *   - POST   /:catalogue/import      - CSV import (via `connectors/csv/`)
 *   - POST   /:catalogue/export      - export to storage
 *
 * HOW TO EXTEND
 *   - Admin endpoints require modulePermission('master_data', <action>).
 *   - Tenant-visible endpoints are read-only and hit the cache first.
 *   - Optimistic concurrency via `If-Match` on updates (Phase 2).
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
      hint: 'See src/modules/platform/master-data/README.md',
    });
  });

router.get('/:catalogue', notImplemented('GET /master-data/:catalogue'));
router.get('/:catalogue/:id', notImplemented('GET /master-data/:catalogue/:id'));
router.post('/:catalogue', notImplemented('POST /master-data/:catalogue'));
router.patch('/:catalogue/:id', notImplemented('PATCH /master-data/:catalogue/:id'));
router.delete('/:catalogue/:id', notImplemented('DELETE /master-data/:catalogue/:id'));
router.post('/:catalogue/import', notImplemented('POST /master-data/:catalogue/import'));
router.post('/:catalogue/export', notImplemented('POST /master-data/:catalogue/export'));

export default router;
