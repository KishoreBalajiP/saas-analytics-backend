/**
 * /api/v1/permissions routes - Dynamic RBAC primitives.
 *
 * WHY IT EXISTS
 *   Permissions are the atomic, dynamic unit of authorisation in this
 *   system. Modules (e.g. `analytics`, `settings`) and actions (e.g.
 *   `view`, `export`) are data, not enums in code. Backed by `iam/
 *   permissions/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET    /modules                 - registered modules
 *   - POST   /modules                 - register a new module
 *   - GET    /modules/:key/actions    - actions for a module
 *   - GET    /                        - permissions list (filterable)
 *   - POST   /                        - create a (module, action) permission
 *   - POST   /bulk                    - bulk-create (idempotent)
 *   - DELETE /:id                     - revoke (only if no roles assigned)
 *
 * HOW TO EXTEND
 *   - Permission key is `<module_key>.<action>`. Validator enforces the
 *     shape; service stores immutable documents.
 *   - Registering a new module invalidates the rbac cache
 *     (`src/cache/` key `iam:rbac:<scope>`).
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
      hint: 'See src/modules/iam/permissions/README.md',
    });
  });

router.get('/modules', notImplemented('GET /permissions/modules'));
router.post('/modules', notImplemented('POST /permissions/modules'));
router.get('/modules/:key/actions', notImplemented('GET /permissions/modules/:key/actions'));
router.get('/', notImplemented('GET /permissions'));
router.post('/', notImplemented('POST /permissions'));
router.post('/bulk', notImplemented('POST /permissions/bulk'));
router.delete('/:id', notImplemented('DELETE /permissions/:id'));

export default router;
