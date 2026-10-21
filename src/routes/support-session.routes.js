/**
 * /api/v1/support-session routes (roadmap 2.3 - the support session itself).
 *
 * WHY IT EXISTS
 *   The tenant UI shows a banner (operator, read-only notice, countdown)
 *   while a support admin views the workspace as a user, and lets the
 *   operator end the session from inside it.
 *
 * ENDPOINTS
 *   - GET  /       the caller's support session, or `{ active: false }`
 *                  for a normal session                       authenticate
 *   - POST /end    a support session ends itself              authenticateImpersonation
 *
 * SECURITY
 *   `authenticateImpersonation` accepts ONLY support sessions (403
 *   IMPERSONATION_SESSION_REQUIRED otherwise) and is the single mutation a
 *   support session may perform. No permission key: a session may always
 *   end itself, and reading one's own session state is not tenant data.
 */

import { Router } from 'express';
import { authenticate, authenticateImpersonation } from '../middleware/auth.middleware.js';
import { validate } from '../validators/index.js';
import supportAccessValidator from '../validators/supportAccess.validator.js';
import supportAccessController from '../controllers/supportAccess.controller.js';

const router = Router();

router.get('/', authenticate, supportAccessController.getCurrentSupportSession);
router.post(
  '/end',
  authenticateImpersonation,
  validate(supportAccessValidator.endCurrentSchema),
  supportAccessController.endCurrentSupportSession,
);

export default router;
