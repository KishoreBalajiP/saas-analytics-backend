/**
 * /api/v1/admin-auth routes - Platform Admin authentication surface.
 *
 * WHY IT EXISTS
 *   Separates admin authentication from tenant authentication so audit,
 *   rate limiting, MFA and abuse-detection policies can differ between
 *   the Admin Portal and the Tenant Portal. Backed by `src/modules/iam/auth/`
 *   (same service layer, `admin` portal).
 *
 * RESPONSIBILITY
 *   - POST   /login                    password (+ optional MFA code)
 *   - POST   /refresh                  rotate the refresh token
 *   - POST   /logout                   revoke the current session
 *   - POST   /mfa/enroll               begin TOTP enrolment (adminAuth)
 *   - POST   /mfa/verify               confirm enrolment (adminAuth)
 *   - GET    /me                       current admin profile (adminAuth)
 *   - POST   /password/forgot          start reset (rate-limited)
 *   - POST   /password/reset           complete reset with emailed token
 *
 * SECURITY
 *   - MFA and /me are behind `adminAuth` (bearer access token, `admin`
 *     audience, session liveness enforced).
 *   - Public credential endpoints are `strictLimiter` throttled + validated.
 *
 * CI NOTE
 *   The public endpoints below intentionally carry no auth middleware, so
 *   they are annotated `ci:routes-exempt` for the `check-routes` guard.
 */

import { Router } from 'express';
import { strictLimiter } from '../middleware/rateLimiter.middleware.js';
import { validateRequest } from '../middleware/validation.middleware.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import {
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  mfaVerifySchema,
} from '../validators/admin.validator.js';
import { adminAuthController } from '../modules/iam/auth/auth.controller.js';
import { adminPasswordController } from '../modules/iam/auth/password.controller.js';
import mfaController from '../modules/iam/auth/mfa.controller.js';

const router = Router();

// Public credential exchange (throttled + validated).
router.post(
  '/login', // ci:routes-exempt: public credential exchange, rate-limited + validated
  strictLimiter,
  validateRequest(loginSchema),
  adminAuthController.login,
);

router.post(
  '/refresh', // ci:routes-exempt: opaque refresh token via HttpOnly cookie or body
  strictLimiter,
  validateRequest(refreshSchema),
  adminAuthController.refresh,
);

router.post(
  '/logout', // ci:routes-exempt: revokes the session bound to the refresh token
  validateRequest(logoutSchema),
  adminAuthController.logout,
);

// Authenticated MFA surface (identity comes from the bearer token).
router.post('/mfa/enroll', adminAuth, mfaController.enroll);
router.post('/mfa/verify', adminAuth, validateRequest(mfaVerifySchema), mfaController.verifyEnrollment);

// Authenticated identity surface.
router.get('/me', adminAuth, adminAuthController.me);

// Public password reset (rate-limited).
router.post(
  '/password/forgot', // ci:routes-exempt: always { ok: true }, no user enumeration
  strictLimiter,
  validateRequest(forgotPasswordSchema),
  adminPasswordController.forgotPassword,
);

router.post(
  '/password/reset', // ci:routes-exempt: stateless emailed token, session family revoked
  strictLimiter,
  validateRequest(resetPasswordSchema),
  adminPasswordController.resetPassword,
);

export default router;
