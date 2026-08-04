/**
 * /api/v1/tenants routes - Tenant (organisation) management.
 *
 * WHY IT EXISTS
 *   A Tenant is the unit of multi-tenancy, billing, and data scoping. The
 *   surface here is admin-shaped (list across all tenants) when invoked by
 *   a Platform Admin and tenant-shaped (one tenant only) when invoked by a
 *   Tenant Admin. Backed by `iam/tenants/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - POST   /                 - create tenant
 *   - GET    /                 - list tenants (Platform Admin only)
 *   - GET    /:id              - detail
 *   - PATCH  /:id              - profile / plan / status
 *   - POST   /:id/suspend      - block all access
 *   - POST   /:id/restore      - reverse suspend
 *   - GET    /:id/members      - users + scoped admins
 *   - GET    /:id/billing      - plan, invoices (Phase 3+)
 *   - GET    /:id/settings     - tenant settings (delegates to settings/)
 *
 * HOW TO EXTEND (Phase 2)
 *   - All admin endpoints require adminAuth + modulePermission('tenants').
 *   - Mutations emit audit events AND cascade session revocation via
 *     `queues/connector.queue.js`-style job (or a new `tenant.queue.js`).
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
      hint: 'See src/modules/iam/tenants/README.md',
    });
  });

router.post('/', notImplemented('POST /tenants'));
router.get('/', notImplemented('GET /tenants'));
router.get('/:id', notImplemented('GET /tenants/:id'));
router.patch('/:id', notImplemented('PATCH /tenants/:id'));
router.post('/:id/suspend', notImplemented('POST /tenants/:id/suspend'));
router.post('/:id/restore', notImplemented('POST /tenants/:id/restore'));
router.get('/:id/members', notImplemented('GET /tenants/:id/members'));
router.get('/:id/billing', notImplemented('GET /tenants/:id/billing'));
router.get('/:id/settings', notImplemented('GET /tenants/:id/settings'));

export default router;
