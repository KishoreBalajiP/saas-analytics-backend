/**
 * /api/v1/tenants routes - Tenant (organisation) management (Sprint 3 - implemented).
 *
 * WHY IT EXISTS
 *   A Tenant is the unit of multi-tenancy, billing, and data scoping. The
 *   surface here is Platform-Admin shaped: create/list/detail/update,
 *   lifecycle transitions (suspend/restore/disable/archive), onboarding,
 *   members, billing, statistics and settings.
 *
 * ENDPOINTS (mounted under /tenants)
 *   - POST   /                 - create tenant (optionally onboard)
 *   - GET    /                 - list tenants (paged, filtered)
 *   - GET    /:id              - tenant detail
 *   - PATCH  /:id              - update profile fields
 *   - POST   /:id/suspend      - temporary block
 *   - POST   /:id/restore      - re-open a suspended/disabled tenant
 *   - POST   /:id/disable      - longer-term block
 *   - POST   /:id/archive      - terminal read-only state
 *   - POST   /:id/init         - run onboarding (owner, roles, settings)
 *   - GET    /:id/members      - users with their roles
 *   - GET    /:id/stats        - per-tenant activity statistics
 *   - GET    /:id/billing      - billing facts
 *   - GET    /:id/settings     - effective settings (grouped or all)
 *   - PATCH  /:id/settings     - upsert tenant overrides
 *   - POST   /:id/owner        - reassign the tenant owner
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('iam.tenants', <action>) -> validate -> handler
 *
 * HOW TO EXTEND
 *   - New lifecycle actions keep the same middleware order.
 *   - `by` attribution comes from the token, never the body.
 */

import { Router } from 'express';
import { validate } from '../validators/index.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import tenantValidator from '../validators/tenant.validator.js';
import tenantController from '../controllers/tenant.controller.js';

const router = Router();

router.post('/', adminAuth, permission('iam.tenants', 'create'), validate(tenantValidator.createTenantSchema), tenantController.createTenant);
router.get('/', adminAuth, permission('iam.tenants', 'view'), validate(tenantValidator.listTenantSchema), tenantController.listTenants);
router.get('/:id', adminAuth, permission('iam.tenants', 'view'), tenantController.getTenant);
router.patch('/:id', adminAuth, permission('iam.tenants', 'update'), validate(tenantValidator.updateTenantSchema), tenantController.updateTenant);
router.post('/:id/suspend', adminAuth, permission('iam.tenants', 'suspend'), validate(tenantValidator.lifecycleSchema), tenantController.suspendTenant);
router.post('/:id/restore', adminAuth, permission('iam.tenants', 'restore'), validate(tenantValidator.lifecycleSchema), tenantController.restoreTenant);
router.post('/:id/disable', adminAuth, permission('iam.tenants', 'suspend'), validate(tenantValidator.lifecycleSchema), tenantController.disableTenant);
router.post('/:id/archive', adminAuth, permission('iam.tenants', 'delete'), validate(tenantValidator.lifecycleSchema), tenantController.archiveTenant);
router.post('/:id/init', adminAuth, permission('iam.tenants', 'create'), validate(tenantValidator.initializeSchema), tenantController.initializeTenant);
router.get('/:id/members', adminAuth, permission('iam.tenants', 'view'), validate(tenantValidator.membersSchema), tenantController.getTenantMembers);
router.get('/:id/stats', adminAuth, permission('iam.tenants', 'view'), tenantController.getTenantStats);
router.get('/:id/billing', adminAuth, permission('iam.tenants', 'view'), tenantController.getTenantBilling);
router.get('/:id/settings', adminAuth, permission('iam.tenants', 'view'), validate(tenantValidator.settingsGetSchema), tenantController.getTenantSettings);
router.patch('/:id/settings', adminAuth, permission('iam.tenants', 'configure'), validate(tenantValidator.settingsUpdateSchema), tenantController.updateTenantSettings);
router.post('/:id/owner', adminAuth, permission('iam.tenants', 'assign'), validate(tenantValidator.changeOwnerSchema), tenantController.changeTenantOwner);

export default router;
