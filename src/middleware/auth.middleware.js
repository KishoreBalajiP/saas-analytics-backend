/**
 * Authentication middleware (foundation shell).
 *
 * WHY IT EXISTS
 *   The auth feature does not exist yet, but the middleware contract must be
 *   established now so future routes mount a stable API and security posture
 *   is never an afterthought.
 *
 * RESPONSIBILITY
 *   Currently it FAILS CLOSED: any route that mounts `authenticate` or
 *   `authorize` returns `501 Not Implemented` until real auth lands in
 *   Sprint 1. This is deliberate - silently letting traffic through would be
 *   a security hole.
 *
 * HOW TO EXTEND
 *   When the auth module is implemented, replace the bodies with:
 *     1. `authenticate`: verify the JWT from the Authorization header or
 *        cookie, then attach `req.user = { id, email, roles }`.
 *     2. `authorize(...roles)`: read `req.user.roles`, require a tenant
 *        context (see tenant middleware), and reject with 403 when missing.
 *   Keep the fail-closed behaviour: throw `ApiError.unauthorized()` on any
 *   invalid/missing credential.
 */

import ApiError from '../utils/ApiError.js';

/**
 * Verify the caller's identity. Not implemented - fails closed.
 * Intended usage: `router.get('/me', authenticate, userController.me)`
 *
 * @param {import('express').Request} _req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
export function authenticate(_req, _res, next) {
  return next(ApiError.notImplemented('Authentication is not implemented yet (Phase 2 - Sprint 1)'));
}

/**
 * Restrict a route to one or more roles. Not implemented - fails closed.
 * Intended usage: `router.post('/', authorize('owner', 'admin'), ctrl.create)`
 *
 * @param  {...string} _allowedRoles
 * @returns {import('express').RequestHandler}
 */
export function authorize(..._allowedRoles) {
  return (_req, _res, next) => {
    return next(ApiError.notImplemented('Authorization is not implemented yet (Phase 2 - Sprint 3)'));
  };
}

/**
 * Optionally authenticated route - future helper for public-with-user routes.
 *
 * @param {import('express').Request} _req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
export function optionalAuthenticate(_req, _res, next) {
  return next(ApiError.notImplemented('Optional authentication is not implemented yet (Phase 2 - Sprint 1)'));
}

export default { authenticate, authorize, optionalAuthenticate };
