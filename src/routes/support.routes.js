/**
 * /api/v1/support routes - Support tooling (Sprint 8 - implemented).
 *
 * WHY IT EXISTS
 *   Admin-only support endpoints: secure impersonation, account recovery,
 *   session revocation, tenant lookups and tenant-scoped broadcasts. Every
 *   action is audited twice.
 *
 * ENDPOINTS AND PERMISSIONS (roadmap 2.1)
 *   - GET  /tenants/:id/lookups          - sanitised diagnostics   support.view
 *   - POST /account/recover              - reset password by email support.update
 *   - POST /account/revoke-sessions      - revoke a user's sessions support.update
 *   - POST /notifications/broadcast      - tenant in-app broadcast support.update
 *   - POST /impersonate                  - start a user session    support.configure
 *   - POST /impersonate/stop             - end an impersonation    support.configure
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('support', <action>) -> adminScope.<mode>
 *   -> validate(schema) -> handler. Tenant-scoped support operators only
 *   reach their own tenant: the lookup and broadcast targets are checked
 *   here, user-targeted actions are re-checked against the persisted scope
 *   in `support.service.js`.
 *
 * HOW TO EXTEND
 *   A new support tool is one validator + one service function + one route;
 *   never skips the RBAC gate, the scope guard or the audit/access-log
 *   double write.
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { adminScope } from '../middleware/adminScope.middleware.js';
import { requireAdminStepUp } from '../middleware/stepUp.middleware.js';
import { validate } from '../validators/index.js';
import supportController from '../controllers/support.controller.js';
import supportValidator from '../validators/support.validator.js';

const router = Router();

router.post(
  '/impersonate',
  adminAuth,
  permission('support', 'configure'),
  adminScope.filtered(),
  validate(supportValidator.impersonateSchema),
  supportController.impersonate,
);
router.post(
  '/impersonate/stop',
  adminAuth,
  permission('support', 'configure'),
  adminScope.filtered(),
  validate(supportValidator.stopImpersonationSchema),
  supportController.stopImpersonation,
);
router.post(
  '/account/recover',
  adminAuth,
  permission('support', 'update'),
  adminScope.filtered(),
  validate(supportValidator.recoverSchema),
  supportController.recoverAccount,
);
router.post(
  '/account/revoke-sessions',
  adminAuth,
  permission('support', 'update'),
  adminScope.filtered(),
  validate(supportValidator.revokeSessionsSchema),
  supportController.revokeAllSessions,
);
router.get(
  '/tenants/:id/lookups',
  adminAuth,
  permission('support', 'view'),
  adminScope.tenant(),
  validate(supportValidator.tenantLookupsSchema),
  supportController.getTenantLookups,
);
router.post(
  '/notifications/broadcast',
  adminAuth,
  permission('support', 'update'),
  adminScope.tenant((req) => req.body?.tenantId ?? null),
  validate(supportValidator.broadcastSchema),
  supportController.broadcastNotification,
);

// support: access redesign (roadmap 2.3). Diagnostics and listings are
// read-only (`support.view`); requesting/revoking access is
// `support.configure`; deciding break-glass is `support.approve` and, in
// the service, an active unscoped super admin other than the requester.
router.get(
  '/tenants/:id/diagnostics',
  adminAuth,
  permission('support', 'view'), adminScope.tenant(),
  validate(supportValidator.diagnosticsSchema),
  supportController.getTenantDiagnostics,
);
router.get(
  '/access-grants',
  adminAuth,
  permission('support', 'view'), adminScope.filtered(),
  validate(supportValidator.listGrantsSchema),
  supportController.listAccessGrants,
);
router.post(
  '/access-grants/break-glass',
  adminAuth,
  permission('support', 'configure'), adminScope.filtered(),
  validate(supportValidator.breakGlassRequestSchema),
  supportController.requestBreakGlass,
);
router.post(
  '/access-grants/:id/approve',
  adminAuth,
  permission('support', 'approve'), adminScope.platform(), requireAdminStepUp(),
  validate(supportValidator.grantDecisionSchema),
  supportController.approveBreakGlass,
);
router.post(
  '/access-grants/:id/deny',
  adminAuth,
  permission('support', 'approve'), adminScope.platform(),
  validate(supportValidator.grantDecisionSchema),
  supportController.denyBreakGlass,
);
router.post(
  '/access-grants/:id/revoke',
  adminAuth,
  permission('support', 'configure'), adminScope.filtered(),
  validate(supportValidator.grantDecisionSchema),
  supportController.revokeAccessGrant,
);
router.get(
  '/impersonations',
  adminAuth,
  permission('support', 'view'), adminScope.filtered(),
  validate(supportValidator.listImpersonationsSchema),
  supportController.listImpersonations,
);

export default router;
