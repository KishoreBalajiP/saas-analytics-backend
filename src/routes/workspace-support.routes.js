/**
 * /api/v1/workspace/support-access routes (roadmap 2.3 - tenant consent).
 *
 * WHY IT EXISTS
 *   A workspace decides whether platform support may open read-only
 *   support sessions, for how long, and sees every grant, session and
 *   support action in its own history.
 *
 * ENDPOINTS
 *   - GET  /                       usable grant, grants, sessions   settings.view
 *   - GET  /activity               support audit history (paged)    settings.view
 *   - POST /grants                 grant { durationHours, note }    settings.configure
 *   - POST /grants/:id/revoke      revoke a consent { reason }      settings.configure
 *   - POST /sessions/:id/end       end a support session { reason } settings.configure
 *
 * MIDDLEWARE ORDER
 *   authenticate -> resolveTenant -> permission('settings', <action>) -> validate -> handler
 *
 * NOTE
 *   A support session itself can read this page (GET) but can never grant,
 *   revoke or end anything here: `authenticate` refuses every unsafe method
 *   for support sessions (403 IMPERSONATION_READ_ONLY).
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import supportAccessValidator from '../validators/supportAccess.validator.js';
import supportAccessController from '../controllers/supportAccess.controller.js';

const router = Router();

router.get(
  '/',
  authenticate,
  resolveTenant,
  permission('settings', 'view'),
  supportAccessController.getWorkspaceSupportAccess,
);
router.get(
  '/activity',
  authenticate,
  resolveTenant,
  permission('settings', 'view'),
  validate(supportAccessValidator.activitySchema),
  supportAccessController.listWorkspaceSupportActivity,
);
router.post(
  '/grants',
  authenticate,
  resolveTenant,
  permission('settings', 'configure'),
  validate(supportAccessValidator.grantConsentSchema),
  supportAccessController.grantConsent,
);
router.post(
  '/grants/:id/revoke',
  authenticate,
  resolveTenant,
  permission('settings', 'configure'),
  validate(supportAccessValidator.revokeConsentSchema),
  supportAccessController.revokeConsent,
);
router.post(
  '/sessions/:id/end',
  authenticate,
  resolveTenant,
  permission('settings', 'configure'),
  validate(supportAccessValidator.endSessionSchema),
  supportAccessController.endSessionAsWorkspace,
);

export default router;
