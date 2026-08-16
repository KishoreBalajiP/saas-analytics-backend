/**
 * /api/v1/admin/support routes - Support tooling (Sprint 8 - implemented).
 *
 * WHY IT EXISTS
 *   Admin-only support endpoints: secure impersonation, account recovery,
 *   session revocation, tenant lookups and tenant-scoped broadcasts. Every
 *   action is audited twice and gated by `support.configure`.
 *
 * ENDPOINTS
 *   - POST /impersonate                  - start a user session (as admin)
 *   - POST /impersonate/stop             - end an impersonation session
 *   - POST /account/recover              - reset password / unlock by email
 *   - POST /account/revoke-sessions      - revoke all of a user's sessions
 *   - GET  /tenants/:id/lookups          - tenant overview + statistics
 *   - POST /notifications/broadcast      - tenant-scoped in-app broadcast
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('support', 'configure') -> validate(schema)
 *   -> handler
 *
 * HOW TO EXTEND
 *   A new support tool is one validator + one service function + one route;
 *   never skips the RBAC gate or the audit/access-log double write.
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import supportController from '../controllers/support.controller.js';
import supportValidator from '../validators/support.validator.js';

const router = Router();

router.post(
  '/impersonate',
  adminAuth,
  permission('support', 'configure'),
  validate(supportValidator.impersonateSchema),
  supportController.impersonate,
);
router.post(
  '/impersonate/stop',
  adminAuth,
  permission('support', 'configure'),
  validate(supportValidator.stopImpersonationSchema),
  supportController.stopImpersonation,
);
router.post(
  '/account/recover',
  adminAuth,
  permission('support', 'configure'),
  validate(supportValidator.recoverSchema),
  supportController.recoverAccount,
);
router.post(
  '/account/revoke-sessions',
  adminAuth,
  permission('support', 'configure'),
  validate(supportValidator.revokeSessionsSchema),
  supportController.revokeAllSessions,
);
router.get(
  '/tenants/:id/lookups',
  adminAuth,
  permission('support', 'configure'),
  validate(supportValidator.tenantLookupsSchema),
  supportController.getTenantLookups,
);
router.post(
  '/notifications/broadcast',
  adminAuth,
  permission('support', 'configure'),
  validate(supportValidator.broadcastSchema),
  supportController.broadcastNotification,
);

export default router;
