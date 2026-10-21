/**
 * /api/v1/workspace/security routes (roadmap 4.E1, mfa-tenant).
 *
 * WHY IT EXISTS
 *   The workspace Owner's security controls: the "MFA required" policy,
 *   the MFA status of every member, and an Owner-assisted MFA reset for a
 *   member who lost their authenticator.
 *
 * ENDPOINTS
 *   - GET   /                              policy             security.view
 *   - PATCH /                              { mfaRequired }    security.configure
 *   - GET   /members                       member MFA status  security.view
 *   - POST  /members/:userId/mfa/reset     { reason }         security.configure + step-up
 *
 * MIDDLEWARE ORDER
 *   authenticate -> resolveTenant -> permission('security', <action>)
 *     -> validate -> [requireUserStepUp] -> handler
 *
 * SECURITY
 *   - `security.configure` is held by the Owner role only (default roles).
 *   - The reset needs a fresh tenant step-up (`POST /auth/step-up`), is
 *     refused for oneself and for a member above the actor's permissions,
 *     and is tenant-scoped (another workspace's member is a 404).
 *   - DEPENDS (integration): none; plan gating is not required for MFA.
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { requireUserStepUp } from '../middleware/stepUp.middleware.js';
import { validate } from '../validators/index.js';
import workspaceSecurityValidator from '../validators/workspaceSecurity.validator.js';
import workspaceSecurityController from '../controllers/workspaceSecurity.controller.js';

const router = Router();

router.get(
  '/',
  authenticate,
  resolveTenant,
  permission('security', 'view'),
  workspaceSecurityController.getPolicy,
);
router.patch(
  '/',
  authenticate,
  resolveTenant,
  permission('security', 'configure'),
  validate(workspaceSecurityValidator.policyUpdateSchema),
  workspaceSecurityController.updatePolicy,
);
router.get(
  '/members',
  authenticate,
  resolveTenant,
  permission('security', 'view'),
  workspaceSecurityController.listMembers,
);
router.post(
  '/members/:userId/mfa/reset',
  authenticate,
  resolveTenant,
  permission('security', 'configure'),
  validate(workspaceSecurityValidator.memberMfaResetSchema),
  requireUserStepUp(),
  workspaceSecurityController.resetMemberMfa,
);

export default router;
