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
 *   authenticate -> validate -> handler
 *
 * HOW TO EXTEND
 *   - `/me` MUST be registered before `/:userId` (Express matches
 *     single-segment paths to the dynamic param).
 *   - passwordHash / lockout internals never leave `user.service.js`.
 */

import { Router } from 'express';
import { validate } from '../validators/index.js';
import { authenticate } from '../middleware/auth.middleware.js';
import userValidator from '../validators/user.validator.js';
import userController from '../controllers/user.controller.js';

const router = Router();

router.get('/me', authenticate, userController.me);
router.patch('/me', authenticate, validate(userValidator.updateMeSchema), userController.updateMe);
router.get('/', authenticate, validate(userValidator.listSchema), userController.list);
router.get('/:userId', authenticate, userController.getById);

export default router;
