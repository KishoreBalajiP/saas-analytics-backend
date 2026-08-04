/**
 * Authentication routes (shell).
 *
 * WHY IT EXISTS
 *   Establishes the route mount point for the future auth feature so the
 *   public API surface is visible from day one.
 *
 * RESPONSIBILITY
 *   None yet - the router is intentionally empty. Requests to `/auth/*`
 *   fall through to the central 404 handler until the feature is built.
 *
 * HOW TO EXTEND
 *   Implement the feature in `src/modules/auth/`, then mount real endpoints
 *   here, e.g.:
 *   ```
 *   import authController from '../modules/auth/auth.controller.js';
 *   import { validateRequest } from '../middleware/validation.middleware.js';
 *   import { strictLimiter } from '../middleware/rateLimiter.middleware.js';
 *
 *   router.post('/register', strictLimiter, validateRequest(registerSchema), authController.register);
 *   router.post('/login', strictLimiter, validateRequest(loginSchema), authController.login);
 *   router.post('/refresh', authController.refresh);
 *   router.post('/logout', authController.logout);
 *   ```
 */

import { Router } from 'express';

const router = Router();

// Auth endpoints will be registered here (see HOW TO EXTEND above).

export default router;
