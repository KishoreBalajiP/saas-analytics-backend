/**
 * /api/v1/admin routes - Platform Admin CRUD + lifecycle (Sprint 2 - implemented).
 *
 * WHY IT EXISTS
 *   Admin Portal entry point for managing Platform Admins (super, platform,
 *   support). Every mutation is on the audit trail: model rows from the audit
 *   plugin, privilege changes and role grants as security events, refusals
 *   as `request.denied` (`audit.middleware.js#auditDenied`). Backed by
 *   `services/admin.service.js`.
 *
 * ENDPOINTS (mounted under /admin)
 *   - GET    /admins                      - list (paged, filtered)
 *   - POST   /admins                      - invite (no password; emailed link)
 *   - GET    /admins/invitations          - invitation history (adminauth)
 *   - POST   /admins/:id/invitation/resend - new link, old one void (adminauth)
 *   - POST   /admins/:id/invitation/revoke - revoke + remove pending admin (adminauth)
 *   - POST   /admins/:id/mfa/reset        - admin-assisted MFA reset (adminauth)
 *   - POST   /admins/:id/password/reset   - admin-assisted password reset (adminauth)
 *   - GET    /admins/:id                  - detail (+ current roles)
 *   - PATCH  /admins/:id                  - update profile / adminType / scope
 *   - POST   /admins/:id/suspend          - block login
 *   - POST   /admins/:id/restore          - unblock
 *   - POST   /admins/:id/roles            - assign role (RBAC-gated)
 *   - DELETE /admins/:id/roles/:roleId    - revoke role
 *   - GET    /admins/:id/audit            - per-admin audit trail
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('iam.admins', <action>) -> adminScope.platform()
 *   -> validate -> handler (tenant-scoped admins never manage administrators)
 *   adminauth: sensitive routes add `requireAdminStepUp()` after validate
 *   (a fresh password + code re-authentication on this session): granting
 *   the `super` type or role, and resetting another admin's credentials
 *   (which also requires an active super actor, never oneself).
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
import { adminScope } from '../middleware/adminScope.middleware.js';
import { requireAdminStepUp, stepUpWhen } from '../middleware/stepUp.middleware.js';
import adminValidator from '../validators/admin.validator.js';
import adminController from '../controllers/admin.controller.js';

const router = Router();

router.get('/admins', adminAuth, permission('iam.admins', 'view'), adminScope.platform(), validate(adminValidator.listSchema), adminController.listAdmins);
router.post('/admins', adminAuth, permission('iam.admins', 'create'), adminScope.platform(), validate(adminValidator.createAdminSchema), requireAdminStepUp({ when: stepUpWhen.grantsSuperType }), adminController.createAdmin);
// adminauth: invitation history (declared before `/admins/:id`).
router.get('/admins/invitations', adminAuth, permission('iam.admins', 'view'), adminScope.platform(), validate(adminValidator.invitationListSchema), adminController.listAdminInvitations);
router.get('/admins/:id', adminAuth, permission('iam.admins', 'view'), adminScope.platform(), adminController.getAdmin);
router.patch('/admins/:id', adminAuth, permission('iam.admins', 'update'), adminScope.platform(), validate(adminValidator.updateAdminSchema), requireAdminStepUp({ when: stepUpWhen.grantsSuperType }), adminController.updateAdmin);
router.post('/admins/:id/suspend', adminAuth, permission('iam.admins', 'suspend'), adminScope.platform(), validate(adminValidator.suspendSchema), adminController.suspendAdmin);
router.post('/admins/:id/restore', adminAuth, permission('iam.admins', 'restore'), adminScope.platform(), validate(adminValidator.restoreSchema), adminController.restoreAdmin);
router.post('/admins/:id/roles', adminAuth, permission('iam.admins', 'assign'), adminScope.platform(), validate(adminValidator.assignRoleSchema), requireAdminStepUp({ when: stepUpWhen.grantsSuperRole }), adminController.assignAdminRole);
router.delete('/admins/:id/roles/:roleId', adminAuth, permission('iam.admins', 'assign'), adminScope.platform(), validate(adminValidator.revokeRoleSchema), adminController.revokeAdminRole);
router.get('/admins/:id/audit', adminAuth, permission('iam.admins', 'view'), adminScope.platform(), validate(adminValidator.listSchema), adminController.getAdminAudit);
// adminauth: invitation lifecycle and admin-assisted credential resets.
router.post('/admins/:id/invitation/resend', adminAuth, permission('iam.admins', 'create'), adminScope.platform(), validate(adminValidator.invitationActionSchema), adminController.resendAdminInvitation);
router.post('/admins/:id/invitation/revoke', adminAuth, permission('iam.admins', 'delete'), adminScope.platform(), validate(adminValidator.invitationActionSchema), adminController.revokeAdminInvitation);
router.post('/admins/:id/mfa/reset', adminAuth, permission('iam.admins', 'configure'), adminScope.platform(), validate(adminValidator.credentialResetSchema), requireAdminStepUp(), adminController.resetAdminMfa);
router.post('/admins/:id/password/reset', adminAuth, permission('iam.admins', 'configure'), adminScope.platform(), validate(adminValidator.credentialResetSchema), requireAdminStepUp(), adminController.resetAdminPassword);

export default router;
