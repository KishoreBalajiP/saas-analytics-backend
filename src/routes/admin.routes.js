/**
 * /api/v1/admin routes - Platform Admin CRUD + lifecycle.
 *
 * WHY IT EXISTS
 *   Admin Portal entry point for managing Platform Admins (super, platform,
 *   support). All endpoints pass through `adminAuth` + RBAC, and every
 *   mutation is captured by `audit.middleware.js`. Backed by `iam/admins/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET    /admins                 - list (paged, filtered)
 *   - POST   /admins                 - create + invite
 *   - GET    /admins/:id             - detail (+ current roles)
 *   - PATCH  /admins/:id             - update profile / status
 *   - POST   /admins/:id/suspend     - block login
 *   - POST   /admins/:id/restore     - unblock
 *   - POST   /admins/:id/roles       - assign role (RBAC-gated)
 *   - DELETE /admins/:id/roles/:roleId - revoke role
 *   - GET    /admins/:id/audit       - per-admin audit trail
 *
 * HOW TO EXTEND (Phase 2)
 *   - Final middleware order on every protected route:
 *     adminAuth -> rbac -> modulePermission('iam', 'view') ->
 *     permission(<action>) -> handler
 *   - Use `validators/admin.validator.js` schemas via `validate(...)` first.
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
      hint: 'See src/modules/iam/admins/README.md',
    });
  });

router.get('/admins', notImplemented('GET /admin/admins'));
router.post('/admins', notImplemented('POST /admin/admins'));
router.get('/admins/:id', notImplemented('GET /admin/admins/:id'));
router.patch('/admins/:id', notImplemented('PATCH /admin/admins/:id'));
router.post('/admins/:id/suspend', notImplemented('POST /admin/admins/:id/suspend'));
router.post('/admins/:id/restore', notImplemented('POST /admin/admins/:id/restore'));
router.post('/admins/:id/roles', notImplemented('POST /admin/admins/:id/roles'));
router.delete('/admins/:id/roles/:roleId', notImplemented('DELETE /admin/admins/:id/roles/:roleId'));
router.get('/admins/:id/audit', notImplemented('GET /admin/admins/:id/audit'));

export default router;
