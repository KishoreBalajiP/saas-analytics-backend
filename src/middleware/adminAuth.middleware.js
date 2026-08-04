/**
 * adminAuth.middleware.js (architecture placeholder).
 *
 * PURPOSE
 *   Resolves the calling admin identity for `/api/v1/admin*` routes.
 *   Verifies the bearer JWT, attaches `req.admin`, and gates the rest of
 *   the pipeline. Built on top of `src/middleware/auth.middleware.js`
 *   but enforces admin-only requirements (no tenant scoping on the
 *   token) and tighter session policy.
 *
 * RESPONSIBILITY (planned, NO implementation yet)
 *   - Read `Authorization: Bearer <jwt>` from the request.
 *   - Verify signature, expiry, audience = admin.
 *   - Resolve `req.admin = { id, type, scopes? }`.
 *   - Reject 401 on missing / invalid / expired tokens.
 *   - Reject 403 when `sessionId` references a revoked session (via
 *     `repositories/session.repository.js`).
 *
 * PHASE 1.2 BEHAVIOUR
 *   Fails closed with 501 when invoked. Routes are intentionally NOT
 *   wired with this middleware yet so they remain reachable for
 *   integration tests; mounting lands in Phase 2 once real auth ships.
 *
 * CODING GUIDELINES
 *   - Must run BEFORE `rbac`, `permission`, `tenantIsolation`.
 *   - Never log credentials, sessions, or tokens.
 *   - Pair with `rateLimiter.middleware.js` on `/login` and `/refresh`.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

/**
 * Express middleware factory. Phase 1.2: returns a strict 501.
 * Phase 2: becomes the real admin auth gate.
 */
export const adminAuth = notImplementedStub('middleware.adminAuth');

/**
 * Optional variant: passes through when the bearer is absent instead of
 * raising. Useful for endpoints that allow either signed-in or public
 * access (e.g. `/feature-flags/resolve`).
 */
export const adminAuthOptional = notImplementedStub('middleware.adminAuthOptional');

export default {
  adminAuth,
  adminAuthOptional,
  _meta: {
    phase: '1.2 - fail-closed placeholder',
    runOrder: 'before rbac / permission / tenantIsolation',
    seeAlso: ['src/middleware/auth.middleware.js'],
  },
};
