/**
 * /api/v1/settings routes - Hot-reloadable, scoped settings.
 *
 * WHY IT EXISTS
 *   Most configuration must be changeable without redeploy. Settings are
 *   platform OR tenant-scoped, typed, versioned, and audited. Reads go
 *   through `src/cache/` so the hot path stays fast. Backed by `platform/
 *   settings/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET    /                     - list (scope-dependent)
 *   - GET    /:key                 - get one (resolves effective value)
 *   - PUT    /:key                 - update (optimistic concurrency)
 *   - POST   /                     - create
 *   - DELETE /:key                 - delete (refuses if read-only)
 *   - GET    /tenants/:tenantId/...  - tenant-scoped views
 *
 * HOW TO EXTEND
 *   - Use `If-Match: <version>` header on writes (Phase 2).
 *   - Writes invalidate the cache key `settings:<scope>:<tenantId>:<key>`.
 *   - Read endpoint never returns `isSecret: true` values in plaintext.
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
      hint: 'See src/modules/platform/settings/README.md',
    });
  });

router.get('/', notImplemented('GET /settings'));
router.get('/:key', notImplemented('GET /settings/:key'));
router.put('/:key', notImplemented('PUT /settings/:key'));
router.post('/', notImplemented('POST /settings'));
router.delete('/:key', notImplemented('DELETE /settings/:key'));
router.get('/tenants/:tenantId/settings', notImplemented('GET /settings/tenants/:tenantId/settings'));

export default router;
