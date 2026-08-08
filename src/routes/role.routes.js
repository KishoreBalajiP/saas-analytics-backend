/**
 * /api/v1/roles routes - Dynamic role management (Sprint 2 - implemented).
 *
 * WHY IT EXISTS
 *   Roles in this system are *data*: Platform Admins compose them from
 *   dynamic permissions and assign them to actors (admins or users) via
 *   join rows (`AdminRole`, `UserRole`). Backed by `services/role.service.js`.
 *
 * ENDPOINTS
 *   - GET    /                      - list roles (filterable: platform | tenant)
 *   - POST   /                      - create role
 *   - GET    /:id                   - role + permission set
 *   - PATCH  /:id                   - rename / description
 *   - DELETE /:id                   - delete (refuses if assigned)
 *   - POST   /:id/permissions       - grant a permission (by key)
 *   - DELETE /:id/permissions       - revoke a permission (by key)
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission(<module.action>) -> validate -> handler
 *
 * HOW TO EXTEND
 *   - Role assignment NEVER edits a Permission; it edits the join row.
 *   - system-defined roles (e.g. `super_admin`) cannot be deleted;
 *     enforced by `services/role.service.js` and surfaced here as 409.
 */

import { Router } from 'express';
import { validate } from '../validators/index.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import roleValidator from '../validators/role.validator.js';
import roleController from '../controllers/role.controller.js';

const router = Router();

router.get('/', adminAuth, permission('iam.roles', 'view'), validate(roleValidator.listSchema), roleController.listRoles);
router.post('/', adminAuth, permission('iam.roles', 'create'), validate(roleValidator.createRoleSchema), roleController.createRole);
router.get('/:id', adminAuth, permission('iam.roles', 'view'), roleController.getRole);
router.patch('/:id', adminAuth, permission('iam.roles', 'update'), validate(roleValidator.updateRoleSchema), roleController.updateRole);
router.delete('/:id', adminAuth, permission('iam.roles', 'delete'), roleController.deleteRole);
router.post('/:id/permissions', adminAuth, permission('iam.roles', 'assign'), validate(roleValidator.addPermissionSchema), roleController.addPermissionToRole);
router.delete('/:id/permissions', adminAuth, permission('iam.roles', 'assign'), validate(roleValidator.removePermissionSchema), roleController.removePermissionFromRole);

export default router;
