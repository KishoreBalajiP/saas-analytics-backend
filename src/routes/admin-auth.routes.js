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
 *   - POST   /login                    password (+ MFA code or recovery code)
 *   - POST   /refresh                  rotate the refresh token
 *   - POST   /logout                   revoke the current session
 *   - POST   /mfa/enroll               begin TOTP enrolment
 *   - POST   /mfa/verify               confirm enrolment, returns recovery codes once
 *   - POST   /mfa/disable              password + code (or recovery code)
 *   - POST   /mfa/recovery-codes       regenerate recovery codes (step-up)
 *   - POST   /step-up                  re-authenticate for sensitive actions
 *   - GET    /me                       current admin profile
 *   - POST   /password/forgot          start reset (rate-limited)
 *   - POST   /password/reset           complete reset with emailed token
 *   - POST   /invitations/preview      inspect an admin invitation (public)
 *   - POST   /invitations/accept       accept it: set password, sign in (public)
 *
 * SECURITY
 *   - MFA and /me are behind `adminAuth` (bearer access token, `admin`
 *     audience, session liveness enforced). MFA calls are rate-limited per
 *     admin.
 *   - adminauth (roadmap 2.2): a privileged admin without MFA signs in to a
 *     session restricted to MFA enrolment. Only `/mfa/enroll`,
 *     `/mfa/verify`, `/me` and `/logout` accept that session
 *     (`adminAuthAllowEnrollment`); every other admin route answers 403
 *     `MFA_ENROLLMENT_REQUIRED`.
 *   - Step-up: `/step-up` (password + current code) stamps the session;
 *     `requireAdminStepUp()` admits sensitive requests for
 *     `ADMIN_STEP_UP_TTL_MS`. Failures are 403 `STEP_UP_FAILED`, count
 *     toward the persisted lockout and share the per-admin MFA bucket.
 *   - Every public endpoint has its own rate-limit bucket
 *     (`adminAuthLimiters`), separate from the tenant portal's.
 *   - The admin refresh cookie has its own name and path; `/refresh` only
 *     honours admin sessions. `/logout` accepts the cookie and/or the
 *     bearer token (`adminAuthOptionalAllowEnrollment`, so an enrolment-only
 *     session can sign out too).
 *
 * CI NOTE
 *   The public endpoints below intentionally carry no auth middleware, so
 *   they are annotated `ci:routes-exempt` for the `check-routes` guard.
 */

import { Router } from 'express';
import env from '../config/env.js';
import { adminAuthLimiters as limit, createRateLimiter } from '../middleware/rateLimiter.middleware.js';
import { validateRequest } from '../middleware/validation.middleware.js';
import {
  adminAuth,
  adminAuthAllowEnrollment,
  adminAuthOptionalAllowEnrollment,
} from '../middleware/adminAuth.middleware.js';
import { requireAdminStepUp } from '../middleware/stepUp.middleware.js';
import {
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  mfaVerifySchema,
  mfaDisableSchema,
  stepUpSchema,
  invitationPreviewSchema,
  invitationAcceptSchema,
} from '../validators/admin.validator.js';
import { adminAuthController } from '../modules/iam/auth/auth.controller.js';
import { adminPasswordController } from '../modules/iam/auth/password.controller.js';
import mfaController from '../modules/iam/auth/mfa.controller.js';
import adminInvitationController from '../modules/iam/auth/adminInvitation.controller.js';

const router = Router();

// adminauth: the admin invitation flow has its own per-IP bucket (never
// shared with the tenant invitation endpoints).
const invitationLimit = createRateLimiter({
  name: 'admin-invitation',
  windowMs: env.security.authRateLimit.windowMs,
  limit: env.security.authRateLimit.invitationMax,
});

// Public credential exchange (throttled + validated).
router.post(
  '/login', // ci:routes-exempt: public credential exchange, rate-limited + validated
  ...limit.login,
  validateRequest(loginSchema),
  adminAuthController.login,
);

router.post(
  '/refresh', // ci:routes-exempt: opaque refresh token via HttpOnly cookie only
  limit.refresh,
  validateRequest(refreshSchema),
  adminAuthController.refresh,
);

router.post(
  '/logout', // ci:routes-exempt: revokes the cookie session and/or the bearer token's session
  adminAuthOptionalAllowEnrollment,
  validateRequest(logoutSchema),
  adminAuthController.logout,
);

// Authenticated MFA surface (identity comes from the bearer token). Enrol
// and verify also accept a session restricted to MFA enrolment.
router.post('/mfa/enroll', adminAuthAllowEnrollment, limit.mfa, mfaController.enroll);
router.post('/mfa/verify', adminAuthAllowEnrollment, limit.mfa, validateRequest(mfaVerifySchema), mfaController.verifyEnrollment);
// Turning MFA off requires step-up inline (password + current code or a
// recovery code); re-enrolment is refused while MFA is enabled.
router.post('/mfa/disable', adminAuth, limit.mfa, validateRequest(mfaDisableSchema), mfaController.disable);
// New recovery codes need a fresh step-up on this session.
router.post('/mfa/recovery-codes', adminAuth, limit.mfa, requireAdminStepUp(), mfaController.regenerateRecoveryCodes);
// Step-up re-authentication (shares the per-admin MFA bucket).
router.post('/step-up', adminAuth, limit.mfa, validateRequest(stepUpSchema), mfaController.stepUp);

// Authenticated identity surface (also for an enrolment-only session, so
// the client can see that it must enrol).
router.get('/me', adminAuthAllowEnrollment, adminAuthController.me);

// Public password reset (rate-limited).
router.post(
  '/password/forgot', // ci:routes-exempt: always { ok: true }, no user enumeration
  limit.passwordForgot,
  validateRequest(forgotPasswordSchema),
  adminPasswordController.forgotPassword,
);

router.post(
  '/password/reset', // ci:routes-exempt: stateless emailed token, session family revoked
  limit.passwordReset,
  validateRequest(resetPasswordSchema),
  adminPasswordController.resetPassword,
);

// adminauth: public admin invitation flow (single-use emailed token).
router.post(
  '/invitations/preview', // ci:routes-exempt: emailed single-use token, rate-limited, generic 400
  invitationLimit,
  validateRequest(invitationPreviewSchema),
  adminInvitationController.preview,
);

router.post(
  '/invitations/accept', // ci:routes-exempt: emailed single-use token, rate-limited, generic 400
  invitationLimit,
  validateRequest(invitationAcceptSchema),
  adminInvitationController.accept,
);

export default router;
