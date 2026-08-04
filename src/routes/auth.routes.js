/**
 * Authentication routes (shell).
 *
 * WHY IT EXISTS
 *   Establishes the route mount point for the future auth feature so the
 *   public API surface is visible from day one.
 *
 * RESPONSIBILITY
 *   Every endpoint returns `501 Not Implemented` with a `hint` to the
 *   module README so callers know where the real implementation lands.
 *
 * HOW TO EXTEND
 *   Implement the feature in `src/modules/iam/auth/`, then mount real
 *   endpoints here, e.g.:
 *   ```
 *   import authController from '../modules/iam/auth/auth.controller.js';
 *   import { validateRequest } from '../middleware/validation.middleware.js';
 *   import { strictLimiter } from '../middleware/rateLimiter.middleware.js';
 *
 *   router.post('/login', strictLimiter, validateRequest(loginSchema), authController.login);
 *   router.post('/refresh', authController.refresh);
 *   router.post('/logout', authController.logout);
 *   ```
 */

import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';

const router = Router();

const HINT = 'See src/modules/iam/auth/README.md';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    res.status(501).json({
      success: false,
      statusCode: 501,
      message: `${op} is not implemented yet (Phase 2 - Sprint 1)`,
      hint: HINT,
    });
  });

// Public surface
router.post('/login', notImplemented('POST /auth/login'));
router.post('/refresh', notImplemented('POST /auth/refresh'));
router.post('/logout', notImplemented('POST /auth/logout'));
router.post('/password/forgot', notImplemented('POST /auth/password/forgot'));
router.post('/password/reset', notImplemented('POST /auth/password/reset'));

// MFA surface (still public until verified)
router.post('/mfa/enroll', notImplemented('POST /auth/mfa/enroll'));
router.post('/mfa/verify', notImplemented('POST /auth/mfa/verify'));

// Authenticated surface - guards land in Phase 2 Sprint 1:
// router.use(authenticate);
router.get('/me', notImplemented('GET /auth/me'));

export default router;
