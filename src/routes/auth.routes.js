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
 *   - POST /register            public self-service signup (email verification required)
 *   - POST /verify-email        consume a stateless verification token
 *   - POST /resend-verification re-issue a verification link (throttled, generic)
 *   - GET  /me                  current tenant user profile (authenticated)
 *   - mfa-tenant (roadmap 4.E1):
 *     - POST /mfa/enroll          begin TOTP enrolment (secret returned once)
 *     - POST /mfa/verify          confirm enrolment, returns recovery codes once
 *     - POST /mfa/disable         password + code (or recovery code)
 *     - POST /mfa/recovery-codes  regenerate recovery codes (step-up)
 *     - POST /step-up             re-authenticate for sensitive actions
 *
 * SECURITY
 *   - Every public endpoint has its OWN rate-limit bucket
 *     (`userAuthLimiters`): login is keyed by IP plus account with a per-IP
 *     ceiling, refresh has a separate looser bucket, and password /
 *     verification / registration each have their own. Tenant resolution for
 *     the tenant portal comes from the `X-Tenant-Id` header via
 *     `resolveTenant` (JWT claim at /me).
 *   - `/me` requires a valid bearer access token (`authenticate`).
 *   - Refresh tokens are set as HttpOnly cookies (path-scoped to this
 *     router) by the controller and are never returned in a body.
 *   - `/logout` accepts the cookie and/or the bearer token
 *     (`optionalAuthenticate`), so it never silently does nothing.
 *   - mfa-tenant: a member the workspace policy requires to use MFA, but
 *     who has none, signs in to a session restricted to MFA enrolment. Only
 *     `/mfa/enroll`, `/mfa/verify`, `/me` (and `/users/me`) and `/logout`
 *     accept it; every other tenant route answers 403
 *     `MFA_ENROLLMENT_REQUIRED`. MFA routes share a per-user bucket
 *     (`userAuthLimiters.mfa`); re-authentication failures answer 403
 *     `STEP_UP_FAILED` and count toward the persisted lockout.
 *
 * CI NOTE
 *   The public endpoints below intentionally carry no auth middleware, so
 *   they are annotated `ci:routes-exempt` for the `check-routes` guard.
 */

import { Router } from 'express';
import { userAuthLimiters as limit } from '../middleware/rateLimiter.middleware.js';
import { validateRequest } from '../middleware/validation.middleware.js';
import {
  authenticate,
  // mfa-tenant: guards that also accept an enrolment-only session.
  authenticateAllowEnrollment,
  optionalAuthenticateAllowEnrollment,
} from '../middleware/auth.middleware.js';
// mfa-tenant: tenant step-up window for sensitive self-service actions.
import { requireUserStepUp } from '../middleware/stepUp.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import {
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  registerSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  // mfa-tenant
  mfaVerifySchema,
  mfaDisableSchema,
  stepUpSchema,
} from '../validators/auth.validator.js';
import { userAuthController } from '../modules/iam/auth/auth.controller.js';
import { userPasswordController } from '../modules/iam/auth/password.controller.js';
import tenantMfaController from '../modules/iam/auth/tenantMfa.controller.js';

const router = Router();

// Public credential exchange (throttled + validated).
router.post(
  '/login', // ci:routes-exempt: public credential exchange, rate-limited + validated
  resolveTenant,
  ...limit.login,
  validateRequest(loginSchema),
  userAuthController.login,
);

router.post(
  '/refresh', // ci:routes-exempt: opaque refresh token via HttpOnly cookie only
  limit.refresh,
  validateRequest(refreshSchema),
  userAuthController.refresh,
);

router.post(
  '/logout', // ci:routes-exempt: revokes the cookie session and/or the bearer token's session
  // mfa-tenant: an enrolment-only session can sign out too.
  optionalAuthenticateAllowEnrollment,
  validateRequest(logoutSchema),
  userAuthController.logout,
);

router.post(
  '/password/forgot', // ci:routes-exempt: always { ok: true }, no user enumeration
  resolveTenant,
  limit.passwordForgot,
  validateRequest(forgotPasswordSchema),
  userPasswordController.forgotPassword,
);

router.post(
  '/password/reset', // ci:routes-exempt: stateless emailed token, session family revoked
  resolveTenant,
  limit.passwordReset,
  validateRequest(resetPasswordSchema),
  userPasswordController.resetPassword,
);

router.post(
  '/register', // ci:routes-exempt: public self-service signup; email verification required before login
  limit.register,
  validateRequest(registerSchema),
  userAuthController.register,
);

router.post(
  '/verify-email', // ci:routes-exempt: stateless emailed verification token
  limit.verifyEmail,
  validateRequest(verifyEmailSchema),
  userAuthController.verifyEmail,
);

router.post(
  '/resend-verification', // ci:routes-exempt: public, throttled; generic response (no enumeration)
  limit.resendVerification,
  validateRequest(resendVerificationSchema),
  userAuthController.resendVerification,
);

// Authenticated surface. mfa-tenant: also for an enrolment-only session, so
// the client can see that it must enrol.
router.get('/me', authenticateAllowEnrollment, userAuthController.me);

// mfa-tenant: tenant-user MFA self-service (identity from the bearer token).
// Enrol and verify also accept a session restricted to MFA enrolment.
router.post('/mfa/enroll', authenticateAllowEnrollment, limit.mfa, tenantMfaController.enroll);
router.post('/mfa/verify', authenticateAllowEnrollment, limit.mfa, validateRequest(mfaVerifySchema), tenantMfaController.verifyEnrollment);
// Turning MFA off requires step-up inline (password + current code or a
// recovery code).
router.post('/mfa/disable', authenticate, limit.mfa, validateRequest(mfaDisableSchema), tenantMfaController.disable);
// New recovery codes need a fresh step-up on this session.
router.post('/mfa/recovery-codes', authenticate, limit.mfa, requireUserStepUp(), tenantMfaController.regenerateRecoveryCodes);
router.post('/step-up', authenticate, limit.mfa, validateRequest(stepUpSchema), tenantMfaController.stepUp);

export default router;
