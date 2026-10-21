/**
 * adminAuth.middleware.js (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Resolves the calling admin identity for `/api/v1/admin*` routes.
 *   Verifies the bearer JWT (audience = `admin`), enforces session
 *   liveness, and attaches `req.admin`. Built on top of
 *   `src/middleware/auth.middleware.js` via the shared `authenticateToken`
 *   factory, so both portals behave identically - only the audience and the
 *   attach key differ.
 *
 * RESPONSIBILITY
 *   - Read `Authorization: Bearer <jwt>` from the request.
 *   - Verify signature, expiry, audience = admin.
 *   - Reject 401 on missing / invalid / expired tokens.
 *   - Reject 401 when `sessionId` references a revoked/expired session (via
 *     `repositories/session.repository.js`).
 *   - Attach `req.admin = { id, sessionId, email, tenantId, adminType }` on
 *     success. `tenantId` is the admin's LIVE `tenantScope` (null =
 *     platform-wide, `*` = cross-tenant) and `adminType` its live type, both
 *     re-read per request (roadmap 2.1), so re-scoping or demoting an admin
 *     applies on its next request.
 *
 * CODING GUIDELINES
 *   - Must run BEFORE `rbac`, `permission`, `adminScope`, `tenantIsolation`.
 *   - Every platform route also declares `permission(module, action)` and an
 *     `adminScope.*` guard (`docs/backend/platform-roles.md`).
 *   - Never log credentials, sessions, or tokens.
 *   - Pair with `rateLimiter.middleware.js` on `/login` and `/refresh`.
 */

import { authenticateToken } from './auth.middleware.js';
import { JWT_AUDIENCES } from '../utils/jwt.js';
import { SESSION_RESTRICTION_MFA_ENROLLMENT } from '../models/Session.js';

/**
 * Require a valid platform-admin access token.
 * Usage: `router.get('/me', adminAuth, adminController.me)`.
 */
export const adminAuth = authenticateToken({ audience: JWT_AUDIENCES.ADMIN, attach: 'admin' });

/**
 * Optional variant: passes through when the bearer is absent/invalid
 * instead of raising. Useful for endpoints that allow either signed-in or
 * public access (e.g. `/feature-flags/resolve`). Never the sole guard.
 */
export const adminAuthOptional = authenticateToken({
  audience: JWT_AUDIENCES.ADMIN,
  attach: 'admin',
  optional: true,
});

/**
 * adminauth: the MFA-enrolment surface (enrol, confirm, `/me`) also accepts a
 * session restricted to enrolment - a privileged admin who signed in
 * without MFA. Every other admin route uses `adminAuth`, which refuses that
 * session with 403 `MFA_ENROLLMENT_REQUIRED`.
 */
export const adminAuthAllowEnrollment = authenticateToken({
  audience: JWT_AUDIENCES.ADMIN,
  attach: 'admin',
  allowRestrictions: [SESSION_RESTRICTION_MFA_ENROLLMENT],
});

/** adminauth: optional variant for `/logout`, so a restricted session can sign out. */
export const adminAuthOptionalAllowEnrollment = authenticateToken({
  audience: JWT_AUDIENCES.ADMIN,
  attach: 'admin',
  optional: true,
  allowRestrictions: [SESSION_RESTRICTION_MFA_ENROLLMENT],
});

export default {
  adminAuth,
  adminAuthOptional,
  adminAuthAllowEnrollment,
  adminAuthOptionalAllowEnrollment,
  _meta: {
    phase: '1 - implemented (shared factory with auth.middleware.js)',
    audience: JWT_AUDIENCES.ADMIN,
    runOrder: 'before rbac / permission / tenantIsolation',
    seeAlso: ['src/middleware/auth.middleware.js'],
  },
};
