/**
 * Authentication middleware (Sprint 1 - implemented).
 *
 * WHY IT EXISTS
 *   Gates every authenticated route. Access tokens are short-lived JWTs
 *   that carry `sessionId`; this middleware verifies the signature/audience
 *   and then checks the referenced session is still `active` in the
 *   database. That DB check is what makes logout and account suspension
 *   effective BEFORE the token expires.
 *
 * RESPONSIBILITY
 *   - `authenticate`  - require a valid tenant-user bearer JWT; attach
 *                       `req.user = { id, sessionId, email, tenantId }`.
 *   - `optionalAuthenticate` - same, but passes through without `req.user`
 *                       when the credential is absent/invalid (public-with-
 *                       user routes). NEVER gates a protected resource.
 *   - `authorize(...)` - role gate. Roles are NOT yet embedded in access
 *                       tokens (RBAC lands Sprint 3), so this fails closed
 *                       with 403 until a role source exists.
 *   - `authenticateToken(opts)` - shared factory also used by
 *                       `adminAuth.middleware.js` for the admin audience.
 *
 * SECURITY RULES
 *   - Fail closed: any missing/invalid/expired token, wrong audience, or
 *     revoked/expired session produces `401 Unauthorized`.
 *   - The bearer is read from the `Authorization` header only. Refresh
 *     tokens live in an HttpOnly cookie and are never accepted here.
 *   - Never log credentials, sessions, or tokens.
 */

import ApiError from '../utils/ApiError.js';
import { verify as verifyJwt, JwtError, JWT_AUDIENCES } from '../utils/jwt.js';
import sessionRepository from '../repositories/session.repository.js';
import roleService from '../services/role.service.js';
import { getActor } from './actor.js';

const BEARER_RE = /^Bearer\s+([^\s]+)$/i;

/** Extract the raw bearer token, or null when the header is missing/malformed. */
function readBearerToken(req) {
  const header = req.headers?.authorization ?? req.headers?.Authorization;
  if (typeof header !== 'string' || header.length === 0) return null;
  const match = BEARER_RE.exec(header);
  return match ? match[1] : null;
}

/** A session is live only while `active` and inside its `expiresAt`. */
function sessionIsLive(session) {
  if (!session || session.status !== 'active') return false;
  if (!session.expiresAt) return false;
  return new Date(session.expiresAt).getTime() > Date.now();
}

/**
 * Shared middleware factory. Verifies the JWT against the given audience,
 * enforces session liveness, and attaches the identity at `req[attach]`.
 *
 * @param {Object} [opts]
 * @param {string} [opts.audience] - required token audience (`user`|`admin`).
 * @param {string} [opts.attach] - request key to attach the identity to.
 * @param {boolean} [opts.optional] - pass through instead of 401 on failure.
 * @returns {import('express').RequestHandler}
 */
export function authenticateToken({ audience = JWT_AUDIENCES.USER, attach = 'user', optional = false } = {}) {
  return async (req, _res, next) => {
    const token = readBearerToken(req);
    if (!token) {
      return optional ? next() : next(ApiError.unauthorized('Authentication required'));
    }

    let payload;
    try {
      ({ payload } = await verifyJwt({ token, audience }));
    } catch (err) {
      if (err instanceof JwtError) {
        return optional ? next() : next(ApiError.unauthorized('Invalid or expired token'));
      }
      return optional ? next() : next(err);
    }

    const sessionId = payload.sessionId ?? null;
    let session = null;
    try {
      session = sessionId ? await sessionRepository.findById(sessionId) : null;
    } catch (err) {
      return optional ? next() : next(err);
    }
    if (!sessionIsLive(session)) {
      return optional ? next() : next(ApiError.unauthorized('Session is no longer active'));
    }

    req[attach] = {
      id: payload.sub,
      sessionId,
      email: payload.email ?? null,
      tenantId: payload.tenantId ?? null,
    };
    return next();
  };
}

/**
 * Require a valid tenant-user access token.
 * Usage: `router.get('/me', authenticate, userController.me)`.
 */
export const authenticate = authenticateToken({ audience: JWT_AUDIENCES.USER, attach: 'user' });

/**
 * Optionally attach `req.user` when a valid token is present; always
 * continues. For public-with-user routes only - never as the sole guard.
 */
export const optionalAuthenticate = authenticateToken({
  audience: JWT_AUDIENCES.USER,
  attach: 'user',
  optional: true,
});

/**
 * Restrict a route to one or more roles.
 * Usage: `router.post('/', authorize('owner', 'admin'), ctrl.create)`.
 *
 * Roles are NOT embedded in access tokens; the actor's role names are
 * resolved from the cached RBAC role set via `role.service#resolveActorRoles`
 * (fails closed with 403 for identities without any role).
 *
 * @param {...string} allowedRoles
 * @returns {import('express').RequestHandler}
 */
export function authorize(...allowedRoles) {
  return async (req, _res, next) => {
    const actor = getActor(req);
    if (!actor) {
      return next(ApiError.forbidden('Role information is not available for this identity'));
    }
    let roles;
    try {
      roles = await roleService.resolveActorRoles({
        actorType: actor.type,
        actorId: actor.id,
        tenantId: actor.tenantId,
      });
    } catch (err) {
      return next(err);
    }
    if (roles.length === 0) {
      return next(ApiError.forbidden('Role information is not available for this identity'));
    }
    if (!allowedRoles.some((role) => roles.includes(role))) {
      return next(ApiError.forbidden('You do not have permission to perform this action'));
    }
    return next();
  };
}

export default { authenticate, optionalAuthenticate, authorize, authenticateToken };
