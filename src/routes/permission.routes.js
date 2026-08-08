/**
 * /api/v1/permissions routes - Dynamic permission catalogue (Sprint 2 - implemented).
 *
 * WHY IT EXISTS
 *   Permissions are data, not code. This surface manages the dynamic RBAC
 *   primitives: modules, (module, action) permissions, and bulk seeding.
 *   Backed by `services/permission.service.js`.
 *
 * ENDPOINTS
 *   - GET    /                  - list permissions (filter by module/action)
 *   - POST   /                  - create a (module, action) permission
 *   - DELETE /                  - soft-delete by key (body `{ permissionKey }`)
 *   - GET    /modules           - list registered modules
 *   - POST   /modules           - register a module (dotted keys allowed)
 *   - GET    /modules/:key/actions - actions available on a module
 *   - POST   /bulk              - bulk-create permissions (idempotent)
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission(<module.action>) -> validate -> handler
 *
 * HOW TO EXTEND
 *   - Keys MUST be `<module_key>.<action>`; enforced by validator + service.
 *   - After any mutation the RBAC cache invalidates automatically.
 */

import { Router } from 'express';
import { validate } from '../validators/index.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import permissionValidator from '../validators/permission.validator.js';
import permissionController from '../controllers/permission.controller.js';

const router = Router();

router.get('/', adminAuth, permission('iam.permissions', 'view'), validate(permissionValidator.listSchema), permissionController.listPermissions);
router.post('/', adminAuth, permission('iam.permissions', 'create'), validate(permissionValidator.createPermissionSchema), permissionController.createPermission);
router.delete('/', adminAuth, permission('iam.permissions', 'delete'), validate(permissionValidator.deletePermissionSchema), permissionController.deletePermission);

router.get('/modules', adminAuth, permission('iam.permissions', 'view'), validate(permissionValidator.listSchema), permissionController.listModules);
router.post('/modules', adminAuth, permission('iam.permissions', 'create'), validate(permissionValidator.createModuleSchema), permissionController.createModule);
router.get('/modules/:key/actions', adminAuth, permission('iam.permissions', 'view'), permissionController.getModuleActions);

router.post('/bulk', adminAuth, permission('iam.permissions', 'create'), validate(permissionValidator.bulkCreateSchema), permissionController.bulkCreatePermissions);

export default router;
