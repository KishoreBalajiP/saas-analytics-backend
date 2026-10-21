/**
 * /api/v1/users routes - Tenant end-user surface (Sprint 2 - implemented).
 *
 * WHY IT EXISTS
 *   Tenant Portal entry point for the self-service user surface. All
 *   endpoints are tenant-scoped: the tenant always comes from the token,
 *   never from the body/params. Backed by `services/user.service.js`.
 *
 * ENDPOINTS
 *   - GET    /me           - the caller's own profile (secrets stripped)
 *   - PATCH  /me           - edit own profile fields
 *   - GET    /             - tenant-scoped paginated list (tenant-admin surface)
 *   - GET    /:userId      - tenant-scoped detail
 *
 * MIDDLEWARE ORDER
 *   authenticate -> permission('users','view') (list/detail) -> validate -> handler
 *
 * HOW TO EXTEND
 *   - `/me` MUST be registered before `/:userId` (Express matches
 *     single-segment paths to the dynamic param).
 *   - passwordHash / lockout internals never leave `user.service.js`.
 */

import { Router } from 'express';
import { validate } from '../validators/index.js';
import { authenticate, authenticateAllowEnrollment } from '../middleware/auth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import userValidator from '../validators/user.validator.js';
import userController from '../controllers/user.controller.js';
// onboarding: password change and own sessions.
import profileController from '../controllers/profile.controller.js';

const router = Router();

// mfa-tenant: an enrolment-only session may read its own profile (the SPA
// learns from `mfa.enrollmentRequired` that it must enrol).
router.get('/me', authenticateAllowEnrollment, userController.me);
router.patch('/me', authenticate, validate(userValidator.updateMeSchema), userController.updateMe);
// onboarding:
router.post('/me/password', authenticate, validate(userValidator.changePasswordSchema), profileController.changePassword);
router.get('/me/sessions', authenticate, profileController.listSessions);
router.delete('/me/sessions/:sessionId', authenticate, profileController.revokeSession);
// Member directory reads expose other members' contact details, so they
// require `users.view` (seeded for every default tenant role).
router.get('/', authenticate, permission('users', 'view'), validate(userValidator.listSchema), userController.list);
router.get('/:userId', authenticate, permission('users', 'view'), userController.getById);

export default router;
