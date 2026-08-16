/**
 * /api/v1/compliance routes - Data-subject requests and evidence (Sprint 8 - implemented).
 *
 * WHY IT EXISTS
 *   Centralised place to file and resolve GDPR/CCPA-style requests
 *   (export, delete, restrict, consent withdraw). Even "no data found"
 *   produces a compliance audit entry (proof of search). Backed by
 *   `governance/compliance/` rows and the export queue.
 *
 * ENDPOINTS
 *   - POST   /requests              - admin files on a subject's behalf
 *   - GET    /requests              - list + filter (admin-only)
 *   - GET    /requests/:id          - status + evidence
 *   - POST   /requests/:id/cancel   - cancel before start
 *   - POST   /public/requests       - subject files for themselves (JWT)
 *   - GET    /public/requests/:id   - subject polls status (signed token)
 *
 * MIDDLEWARE ORDER
 *   admin routes: adminAuth -> permission('compliance', <action>) -> validate
 *   public routes: authenticate -> validate
 *
 * HOW TO EXTEND
 *   - Internal `/requests` requires `compliance.create`; cancellation requires
 *     `compliance.update`; listing/status require `compliance.view`.
 *   - External endpoints use a signed HMAC token (`pollToken`) instead of a
 *     bearer credential.
 *   - Every state change emits an audit entry (service layer).
 */

import { Router } from 'express';
import { validate } from '../validators/index.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import complianceValidator from '../validators/compliance.validator.js';
import complianceController from '../controllers/compliance.controller.js';

const router = Router();

// Internal (admin-gated)
router.post('/requests', adminAuth, permission('compliance', 'create'), validate(complianceValidator.createSchema), complianceController.createRequest);
router.get('/requests', adminAuth, permission('compliance', 'view'), validate(complianceValidator.listSchema), complianceController.listRequests);
router.get('/requests/:id', adminAuth, permission('compliance', 'view'), validate(complianceValidator.paramSchema), complianceController.getRequest);
router.post('/requests/:id/cancel', adminAuth, permission('compliance', 'update'), validate(complianceValidator.cancelSchema), complianceController.cancelRequest);

// Public subject-facing (JWT to file, signed token to poll)
router.post('/public/requests', authenticate, validate(complianceValidator.publicCreateSchema), complianceController.createSubjectRequest);
router.get(
  '/public/requests/:id', // ci:routes-exempt: self-authenticating HMAC token bound to the request
  validate(complianceValidator.publicStatusSchema),
  complianceController.getSubjectRequest,
);

export default router;
