/**
 * /api/v1/admin-auth routes - Platform Admin authentication surface.
 *
 * WHY IT EXISTS
 *   Separates admin authentication from tenant authentication so audit,
 *   rate limiting, MFA and abuse-detection policies can differ between
 *   the Admin Portal and the Tenant Portal. Backed by `iam/auth/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - POST   /login                    password (+optional MFA)
 *   - POST   /refresh                  rotate refresh token
 *   - POST   /logout                   revoke current session
 *   - POST   /mfa/enroll               begin TOTP enrolment
 *   - POST   /mfa/verify               verify TOTP code
 *   - GET    /me                       current admin profile
 *   - POST   /password/forgot          start reset (rate-limited)
 *   - POST   /password/reset           complete reset
 *
 * HOW TO EXTEND (Phase 2)
 *   - Add `adminAuth.middleware.js` to private endpoints below /me.
 *   - Each login MUST emit a `governance/audit-logs/` event.
 *   - Phase 1.2 returns 501 for every route. Tests in this phase do NOT
 *     hit any of them, so we can iterate freely.
 */

import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';

const router = Router();

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    res.status(501).json({
      success: false,
      statusCode: 501,
      message: `${op} is not implemented yet (Phase 1.2 architecture placeholder)`,
      hint: 'See src/modules/iam/auth/README.md',
    });
  });

// Public surface
router.post('/login', notImplemented('POST /admin-auth/login'));
router.post('/refresh', notImplemented('POST /admin-auth/refresh'));
router.post('/logout', notImplemented('POST /admin-auth/logout'));
router.post('/password/forgot', notImplemented('POST /admin-auth/password/forgot'));
router.post('/password/reset', notImplemented('POST /admin-auth/password/reset'));

// MFA surface (still public until verified)
router.post('/mfa/enroll', notImplemented('POST /admin-auth/mfa/enroll'));
router.post('/mfa/verify', notImplemented('POST /admin-auth/mfa/verify'));

// Authenticated surface - guards will land in Phase 2:
// router.use(adminAuth, rbac.requireRole('platform' /* or super */));
router.get('/me', notImplemented('GET /admin-auth/me'));

export default router;
