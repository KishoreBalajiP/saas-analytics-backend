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
 *   `authorize` returns `501 Not Implemented` until real auth lands. This is
 *   deliberate - silently letting traffic through would be a security hole.
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
 */
export function authenticate(_req, _res, next) {
  return next(
    new ApiError(501, 'Authentication is not implemented yet', {
      code: 'AUTH_NOT_IMPLEMENTED',
    }),
  );
}

/**
 * Restrict a route to one or more roles. Not implemented - fails closed.
 * Intended usage: `router.post('/', authorize('owner', 'admin'), ctrl.create)`
 */
export function authorize(..._allowedRoles) {
  return (_req, _res, next) => {
    return next(
      new ApiError(501, 'Authorization is not implemented yet', {
        code: 'AUTHZ_NOT_IMPLEMENTED',
      }),
    );
  };
}

/** Optionally authenticated route - future helper for public-with-user routes. */
export function optionalAuthenticate(_req, _res, next) {
  return next(
    new ApiError(501, 'Authentication is not implemented yet', {
      code: 'AUTH_NOT_IMPLEMENTED',
    }),
  );
}
