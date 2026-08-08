/**
 * /api/v1/admin routes - Platform Admin CRUD + lifecycle (Sprint 2 - implemented).
 *
 * WHY IT EXISTS
 *   Admin Portal entry point for managing Platform Admins (super, platform,
 *   support). Every mutation is captured by `audit.middleware.js`. Backed by
 *   `services/admin.service.js`.
 *
 * ENDPOINTS (mounted under /admin)
 *   - GET    /admins                      - list (paged, filtered)
 *   - POST   /admins                      - create + invite
 *   - GET    /admins/:id                  - detail (+ current roles)
 *   - PATCH  /admins/:id                  - update profile / adminType / scope
 *   - POST   /admins/:id/suspend          - block login
 *   - POST   /admins/:id/restore          - unblock
 *   - POST   /admins/:id/roles            - assign role (RBAC-gated)
 *   - DELETE /admins/:id/roles/:roleId    - revoke role
 *   - GET    /admins/:id/audit            - per-admin audit trail
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('iam.admins', <action>) -> validate -> handler
 *
 * HOW TO EXTEND
 *   - `/admin-auth/*` lives in `admin-auth.routes.js` (mounted separately);
 *     this router owns only admin *management*.
 *   - `by` attribution comes from the token, never the body.
 */

import { Router } from 'express';
import { validate } from '../validators/index.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import adminValidator from '../validators/admin.validator.js';
import adminController from '../controllers/admin.controller.js';

const router = Router();

router.get('/admins', adminAuth, permission('iam.admins', 'view'), validate(adminValidator.listSchema), adminController.listAdmins);
router.post('/admins', adminAuth, permission('iam.admins', 'create'), validate(adminValidator.createAdminSchema), adminController.createAdmin);
router.get('/admins/:id', adminAuth, permission('iam.admins', 'view'), adminController.getAdmin);
router.patch('/admins/:id', adminAuth, permission('iam.admins', 'update'), validate(adminValidator.updateAdminSchema), adminController.updateAdmin);
router.post('/admins/:id/suspend', adminAuth, permission('iam.admins', 'suspend'), validate(adminValidator.suspendSchema), adminController.suspendAdmin);
router.post('/admins/:id/restore', adminAuth, permission('iam.admins', 'restore'), validate(adminValidator.restoreSchema), adminController.restoreAdmin);
router.post('/admins/:id/roles', adminAuth, permission('iam.admins', 'assign'), validate(adminValidator.assignRoleSchema), adminController.assignAdminRole);
router.delete('/admins/:id/roles/:roleId', adminAuth, permission('iam.admins', 'assign'), validate(adminValidator.revokeRoleSchema), adminController.revokeAdminRole);
router.get('/admins/:id/audit', adminAuth, permission('iam.admins', 'view'), validate(adminValidator.listSchema), adminController.getAdminAudit);

export default router;
