/**
 * /api/v1/access-requests routes - workspace access requests.
 *
 * ENDPOINTS
 *   - POST /               - anyone submits a request (rate-limited)
 *   - GET  /               - review queue        iam.access_requests.view
 *   - POST /:id/approve    - invite into tenant  iam.access_requests.approve
 *   - POST /:id/reject     - decline             iam.access_requests.approve
 *
 * SECURITY (roadmap 2.1)
 *   Review is gated by explicit permission keys (granted to the built-in
 *   platform_admin role; auditors can view), never by `adminType`, and is
 *   platform-wide: tenant-scoped admins are refused because the queue holds
 *   every requester's personal data. Approval only invites with a role from
 *   `APPROVABLE_ROLES` (Viewer / Manager).
 */

import { Router } from 'express';
import { strictLimiter } from '../middleware/rateLimiter.middleware.js';
import { validate } from '../validators/index.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { adminScope } from '../middleware/adminScope.middleware.js';
import { optionalAuthenticate } from '../middleware/auth.middleware.js';
import validator from '../validators/accessRequest.validator.js';
import controller from '../controllers/accessRequest.controller.js';

const router = Router();
router.post('/', optionalAuthenticate, strictLimiter, validate(validator.submitSchema), controller.submit);
router.get('/', adminAuth, permission('iam.access_requests', 'view'), adminScope.platform(), validate(validator.listSchema), controller.list);
router.post('/:id/approve', adminAuth, permission('iam.access_requests', 'approve'), adminScope.platform(), validate(validator.decisionSchema), controller.approve);
router.post('/:id/reject', adminAuth, permission('iam.access_requests', 'approve'), adminScope.platform(), validate(validator.rejectSchema), controller.reject);
export default router;
