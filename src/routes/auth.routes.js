/**
 * /api/v1/auth routes - Tenant Portal authentication surface.
 *
 * WHY IT EXISTS
 *   Mount point for the tenant login/refresh/logout/password surface.
 *   Backed by `src/modules/iam/auth/` (controllers + services).
 *
 * RESPONSIBILITY
 *   - POST /login               exchange credentials for a session + tokens
 *   - POST /refresh             rotate the refresh token
 *   - POST /logout              revoke the current session
 *   - POST /password/forgot     request a reset link (rate-limited)
 *   - POST /password/reset      complete the reset with the emailed token
 *   - GET  /me                  current tenant user profile (authenticated)
 *
 * SECURITY
 *   - Public credential endpoints are `strictLimiter` throttled and
 *     validated. Tenant resolution for the tenant portal comes from the
 *     `X-Tenant-Id` header via `resolveTenant` (JWT claim at /me).
 *   - `/me` requires a valid bearer access token (`authenticate`).
 *   - Refresh tokens are set as HttpOnly cookies by the controller.
 *
 * CI NOTE
 *   The public endpoints below intentionally carry no auth middleware, so
 *   they are annotated `ci:routes-exempt` for the `check-routes` guard.
 */

import { Router } from 'express';
import { strictLimiter } from '../middleware/rateLimiter.middleware.js';
import { validateRequest } from '../middleware/validation.middleware.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import {
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../validators/auth.validator.js';
import { userAuthController } from '../modules/iam/auth/auth.controller.js';
import { userPasswordController } from '../modules/iam/auth/password.controller.js';

const router = Router();

// Public credential exchange (throttled + validated).
router.post(
  '/login', // ci:routes-exempt: public credential exchange, rate-limited + validated
  resolveTenant,
  strictLimiter,
  validateRequest(loginSchema),
  userAuthController.login,
);

router.post(
  '/refresh', // ci:routes-exempt: opaque refresh token via HttpOnly cookie or body
  strictLimiter,
  validateRequest(refreshSchema),
  userAuthController.refresh,
);

router.post(
  '/logout', // ci:routes-exempt: revokes the session bound to the refresh token
  validateRequest(logoutSchema),
  userAuthController.logout,
);

router.post(
  '/password/forgot', // ci:routes-exempt: always { ok: true }, no user enumeration
  resolveTenant,
  strictLimiter,
  validateRequest(forgotPasswordSchema),
  userPasswordController.forgotPassword,
);

router.post(
  '/password/reset', // ci:routes-exempt: stateless emailed token, session family revoked
  resolveTenant,
  strictLimiter,
  validateRequest(resetPasswordSchema),
  userPasswordController.resetPassword,
);

// Authenticated surface.
router.get('/me', authenticate, userAuthController.me);

export default router;
