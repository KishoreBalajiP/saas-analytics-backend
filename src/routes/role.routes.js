/**
 * /api/v1/roles routes - Dynamic role management.
 *
 * WHY IT EXISTS
 *   Roles in this system are *data*: Platform Admins compose them from
 *   dynamic permissions and assign them to actors (admins or users) via
 *   join rows (`AdminRole`, `UserRole`). Backed by `iam/roles/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET    /                  - list roles (filterable: platform | tenant)
 *   - POST   /                  - create role
 *   - GET    /:id               - role + permission set
 *   - PATCH  /:id               - rename / description
 *   - DELETE /:id               - delete (refuses if assigned)
 *   - POST   /:id/permissions   - assign permission(s)
 *   - DELETE /:id/permissions/:permId - revoke permission
 *
 * HOW TO EXTEND
 *   - Role assignment NEVER edits a Permission; it edits the join row.
 *   - system-defined roles (e.g. `super_admin`) cannot be deleted;
 *     enforced by `services/role.service.js` and surfaced here as 409.
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
      hint: 'See src/modules/iam/roles/README.md',
    });
  });

router.get('/', notImplemented('GET /roles'));
router.post('/', notImplemented('POST /roles'));
router.get('/:id', notImplemented('GET /roles/:id'));
router.patch('/:id', notImplemented('PATCH /roles/:id'));
router.delete('/:id', notImplemented('DELETE /roles/:id'));
router.post('/:id/permissions', notImplemented('POST /roles/:id/permissions'));
router.delete('/:id/permissions/:permId', notImplemented('DELETE /roles/:id/permissions/:permId'));

export default router;
