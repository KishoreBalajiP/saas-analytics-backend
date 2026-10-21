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
 *   - POST   /:id/owner        - reassign the tenant owner (break-glass;
 *                                grants Owner, demotes the previous owner)
 *   - GET    /:id/deletion     - latest workspace deletion record
 *   - POST   /:id/deletion/cancel - cancel a scheduled deletion (reopens)
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('iam.tenants', <action>) -> adminScope.<mode>
 *   -> validate -> handler. `/:id/*` routes use `adminScope.tenant()` so a
 *   tenant-scoped admin only reaches its own tenant; the list is clamped to
 *   the scope (`adminScope.filtered()`); creating tenants is platform-only.
 *
 * HOW TO EXTEND
 *   - New lifecycle actions keep the same middleware order.
 *   - `by` attribution comes from the token, never the body.
 */

import { Router } from 'express';
import { validate } from '../validators/index.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { adminScope } from '../middleware/adminScope.middleware.js';
// adminauth: plaintext secret settings also need a fresh step-up.
import { requireAdminStepUp, stepUpWhen } from '../middleware/stepUp.middleware.js';
// config: dedicated secret-settings permissions.
import { permissionIf, queryFlag, requireTenantSecretWrite } from '../middleware/configAccess.middleware.js';
import tenantValidator from '../validators/tenant.validator.js';
import tenantController from '../controllers/tenant.controller.js';
import invitationController from '../controllers/invitation.controller.js';
import invitationValidator from '../validators/invitation.validator.js';
// members: workspace deletion oversight (roadmap 2.10).
import tenantDeletionController from '../controllers/tenantDeletion.controller.js';
import { adminTenantDeletionSchema, adminCancelDeletionSchema } from '../validators/workspaceMembers.validator.js';

const router = Router();

router.post('/', adminAuth, permission('iam.tenants', 'create'), adminScope.platform(), validate(tenantValidator.createTenantSchema), tenantController.createTenant);
router.get('/', adminAuth, permission('iam.tenants', 'view'), adminScope.filtered(), validate(tenantValidator.listTenantSchema), tenantController.listTenants);
router.get('/:id', adminAuth, permission('iam.tenants', 'view'), adminScope.tenant(), tenantController.getTenant);
router.patch('/:id', adminAuth, permission('iam.tenants', 'update'), adminScope.tenant(), validate(tenantValidator.updateTenantSchema), tenantController.updateTenant);
router.post('/:id/suspend', adminAuth, permission('iam.tenants', 'suspend'), adminScope.tenant(), validate(tenantValidator.lifecycleSchema), tenantController.suspendTenant);
router.post('/:id/restore', adminAuth, permission('iam.tenants', 'restore'), adminScope.tenant(), validate(tenantValidator.lifecycleSchema), tenantController.restoreTenant);
router.post('/:id/disable', adminAuth, permission('iam.tenants', 'suspend'), adminScope.tenant(), validate(tenantValidator.lifecycleSchema), tenantController.disableTenant);
router.post('/:id/archive', adminAuth, permission('iam.tenants', 'delete'), adminScope.tenant(), validate(tenantValidator.lifecycleSchema), tenantController.archiveTenant);
router.post('/:id/init', adminAuth, permission('iam.tenants', 'create'), adminScope.tenant(), validate(tenantValidator.initializeSchema), tenantController.initializeTenant);
router.get('/:id/members', adminAuth, permission('iam.tenants', 'view'), adminScope.tenant(), validate(tenantValidator.membersSchema), tenantController.getTenantMembers);
router.get('/:id/stats', adminAuth, permission('iam.tenants', 'view'), adminScope.tenant(), tenantController.getTenantStats);
router.get('/:id/billing', adminAuth, permission('iam.tenants', 'view'), adminScope.tenant(), tenantController.getTenantBilling);
// config: reading secret settings in plaintext needs the dedicated
// `settings.secrets.view` permission (and is audited) plus a fresh step-up
// (adminauth); writing a secret key needs `settings.secrets.update` on top of
// `iam.tenants.configure`. Plain reads stay on `iam.tenants.view`.
router.get(
  '/:id/settings',
  adminAuth,
  permission('iam.tenants', 'view'),
  permissionIf((req) => queryFlag(req, 'includeSecrets'), 'settings.secrets', 'view'),
  adminScope.tenant(),
  validate(tenantValidator.settingsGetSchema),
  requireAdminStepUp({ when: stepUpWhen.readsSecrets }),
  tenantController.getTenantSettings,
);
router.patch('/:id/settings', adminAuth, permission('iam.tenants', 'configure'), adminScope.tenant(), validate(tenantValidator.settingsUpdateSchema), requireTenantSecretWrite, tenantController.updateTenantSettings);
router.post('/:id/owner', adminAuth, permission('iam.tenants', 'assign'), adminScope.tenant(), validate(tenantValidator.changeOwnerSchema), tenantController.changeTenantOwner);
router.get('/:id/invitations', adminAuth, permission('iam.tenants', 'view'), adminScope.tenant(), validate(invitationValidator.listSchema), invitationController.list);
router.post('/:id/invitations', adminAuth, permission('iam.tenants', 'create'), adminScope.tenant(), validate(invitationValidator.createSchema), invitationController.create);
router.post('/:id/invitations/resend', adminAuth, permission('iam.tenants', 'update'), adminScope.tenant(), validate(invitationValidator.resendSchema), invitationController.resend);
router.post('/:id/invitations/:invitationId/revoke', adminAuth, permission('iam.tenants', 'update'), adminScope.tenant(), validate(invitationValidator.revokeSchema), invitationController.revoke);
// members: workspace deletion oversight (roadmap 2.10).
router.get('/:id/deletion', adminAuth, permission('iam.tenants', 'view'), adminScope.tenant(), validate(adminTenantDeletionSchema), tenantDeletionController.getDeletion);
router.post('/:id/deletion/cancel', adminAuth, permission('iam.tenants', 'restore'), adminScope.tenant(), validate(adminCancelDeletionSchema), tenantDeletionController.cancelDeletion);

export default router;
