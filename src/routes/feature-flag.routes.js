/**
 * /api/v1/feature-flags routes - Dynamic feature flag registry + resolver.
 *
 * WHY IT EXISTS
 *   Decouple deployment from release. Flags have rollout strategies
 *   (all-on, tenant allow-list, percentage, attribute rule). The runtime
 *   `/resolve` endpoint is what the rest of the platform calls.
 *
 *   Backed by `platform/feature-flags/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET    /                      - list flags (admin)
 *   - POST   /                      - create
 *   - GET    /:key                  - detail
 *   - PATCH  /:key                  - update rollout
 *   - DELETE /:key                  - delete (refuses if production-bound)
 *   - POST   /resolve               - runtime resolution (Phase 2 SDK)
 *
 * HOW TO EXTEND
 *   - `/resolve` is the ONLY allowed read surface for running code.
 *   - All writes invalidate `feature-flags:<scope>` cache keys.
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
      hint: 'See src/modules/platform/feature-flags/README.md',
    });
  });

router.get('/', notImplemented('GET /feature-flags'));
router.post('/', notImplemented('POST /feature-flags'));
router.get('/:key', notImplemented('GET /feature-flags/:key'));
router.patch('/:key', notImplemented('PATCH /feature-flags/:key'));
router.delete('/:key', notImplemented('DELETE /feature-flags/:key'));
router.post('/resolve', notImplemented('POST /feature-flags/resolve'));

export default router;
