/**
 * Authentication middleware (Sprint 1 - implemented).
 *
 * WHY IT EXISTS
 *   Gates every authenticated route. Access tokens are short-lived JWTs
 *   that carry `sessionId`; this middleware verifies the signature/audience,
 *   checks the referenced session is still `active` in the database, and
 *   checks the account (and a tenant user's workspace) is still `active`.
 *   Those checks are what make logout and user/tenant suspension effective
 *   BEFORE the token expires.
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
 *   - `verifyAccessToken({ token, audience })` - the same checks without
 *                       Express, reused by the Socket.IO handshake.
 *   - Authenticated POST/PUT/PATCH/DELETE requests that carry an
 *     `X-Idempotency-Key` go through `idempotency.middleware.js` right after
 *     the identity is verified (keys scoped by actor + tenant + route).
 *   - Support sessions (roadmap 2.3): a session opened by a support admin
 *     (`Session.impersonatedBy`) is READ-ONLY. Every non-safe method
 *     (anything but GET/HEAD/OPTIONS) is refused with 403
 *     `IMPERSONATION_READ_ONLY` before any handler runs, and the operator id
 *     rides `req.user.impersonatedBy` (and the async actor context) so every
 *     access-log and audit row of the request records who acted.
 *     `authenticateImpersonation` is the only exception: it guards the one
 *     endpoint that lets a support session end itself.
 *
 * SECURITY RULES
 *   - Fail closed: any missing/invalid/expired token, wrong audience,
 *     revoked/expired session, or non-active account/tenant produces
 *     `401 Unauthorized` (with `ACCOUNT_SUSPENDED`, `ACCOUNT_NOT_ACTIVE` or
 *     `TENANT_NOT_ACTIVE` as the code for the status cases).
 *   - The bearer is read from the `Authorization` header only. Refresh
 *     tokens live in an HttpOnly cookie and are never accepted here.
 *   - Never log credentials, sessions, or tokens.
 *   - adminauth: a RESTRICTED session (`session.restriction`, e.g. a
 *     privileged admin who must still enrol MFA) is refused with 403
 *     `MFA_ENROLLMENT_REQUIRED` unless the route opted in through
 *     `allowRestrictions`. Only the enrolment surface does.
 *   - A refusal of a presented credential (forged/invalid token, revoked
 *     session, suspended account or tenant) and every `authorize` 403 is
 *     recorded as a rate-limited `request.denied` security event
 *     (`audit.middleware.js#auditDenied`). Expired tokens and requests with
 *     no credential are routine and not recorded.
 */
import ApiError from '../utils/ApiError.js';
import tenantMfaPolicy from '../modules/iam/auth/tenantMfaPolicy.js';
import { SESSION_RESTRICTION_MFA_ENROLLMENT } from '../models/Session.js';
import { verify as verifyJwt, JwtError, JWT_AUDIENCES } from '../utils/jwt.js';
import sessionRepository from '../repositories/session.repository.js';
import roleService from '../services/role.service.js';
import actorStatus from '../modules/iam/auth/actorStatus.service.js';
import { getActor } from './actor.js';
import { idempotency } from './idempotency.middleware.js';
import { runWithContext } from '../utils/actorContext.js';
import { auditDenied } from './audit.middleware.js';
import { ERROR_CODES } from '../config/constants.js';
import { SUPPORT_ERROR_CODES, IMPERSONATION_SAFE_METHODS } from '../constants/support.js';

/** adminauth: 403 for a restricted session on a route that does not allow it. */
function restrictedSessionError(restriction) {
  const err = ApiError.forbidden(
    restriction === 'mfa_enrollment'
      ? 'Set up multi-factor authentication to continue'
      : 'This session is restricted',
  );
  err.code = ERROR_CODES.MFA_ENROLLMENT_REQUIRED;
  return err;
}

/**
 * Replay protection for authenticated mutations. Fails open on a cache
 * outage (logged) so a Redis incident cannot block every write.
 */
const replayGuard = idempotency({ failOpen: true });

const BEARER_RE = /^Bearer\s+([^\s]+)$/i;

/** support: methods a read-only support session may use. */
const SAFE_METHODS = new Set(IMPERSONATION_SAFE_METHODS);

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
 * Verify an access token end to end: signature + expiry + audience, a live
 * session that belongs to the token's subject, and an active account (plus
 * an active tenant for tenant users).
 *
 * @param {Object} params
 * @param {string} params.token - raw bearer JWT.
 * @param {string} [params.audience] - `user` | `admin`.
 * @param {string[]} [params.allowRestrictions] - adminauth: session
 *   restrictions this caller accepts (default none: restricted sessions are
 *   refused with 403 `MFA_ENROLLMENT_REQUIRED`).
 * @returns {Promise<{ id: string, sessionId: string, email: string|null, tenantId: string|null, adminType?: string|null, expiresAt: number|null, restriction: string|null, stepUpAt: number|null, impersonation: boolean, impersonatedBy: string|null }>}
 *   `impersonation` is true for a support session; `impersonatedBy` is then
 *   the operator (admin) id, read from the server-side session.
 * @throws {ApiError} 401 on any failure (other errors propagate).
 */
export async function verifyAccessToken({ token, audience = JWT_AUDIENCES.USER, allowRestrictions = [] }) {
  if (typeof token !== 'string' || token.length === 0) {
    throw ApiError.unauthorized('Authentication required');
  }
  let payload;
  try {
    ({ payload } = await verifyJwt({ token, audience }));
  } catch (err) {
    if (err instanceof JwtError) {
      const invalid = ApiError.unauthorized('Invalid or expired token');
      // Audit reason (not sent to the client): expiry is routine, anything
      // else (bad signature, wrong audience, malformed) is not.
      invalid.denialReason = err.code === 'EXPIRED' ? 'token_expired' : 'token_invalid';
      throw invalid;
    }
    throw err;
  }

  const isAdmin = audience === JWT_AUDIENCES.ADMIN;
  // From here the token is authentic, so its subject may be named in audit
  // records of the refusal.
  const subject = { type: isAdmin ? 'admin' : 'user', id: payload.sub, tenantId: payload.tenantId ?? null };
  const inactiveSession = () => Object.assign(ApiError.unauthorized('Session is no longer active'), {
    denialReason: 'session_inactive',
    subject,
  });

  const sessionId = payload.sessionId ?? null;
  const session = sessionId ? await sessionRepository.findById(sessionId) : null;
  if (!sessionIsLive(session)) throw inactiveSession();
  // The session must be the subject's own (defence in depth).
  if (session.actorId && String(session.actorId) !== String(payload.sub)) {
    throw inactiveSession();
  }

  // A valid token is not enough: a suspended account or workspace loses
  // access on its next request, not when the token expires.
  let account;
  try {
    account = await actorStatus.assertActorActive({
      actorType: isAdmin ? 'admin' : 'user',
      actorId: payload.sub,
    });
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 401) {
      err.denialReason = String(err.code ?? 'account_not_active').toLowerCase();
      err.subject = subject;
    }
    throw err;
  }
  // A tenant user's token must name the workspace the account belongs to.
  if (!isAdmin && payload.tenantId && account?.tenantId && String(payload.tenantId) !== account.tenantId) {
    throw inactiveSession();
  }

  // Workspace policy changes apply to already-live sessions on their very
  // next request, not only after refresh or a new login.
  let restriction = session.restriction ?? null;
  if (
    !isAdmin &&
    !session.impersonatedBy &&
    !account?.mfaEnabled &&
    (await tenantMfaPolicy.isMfaRequired(account))
  ) {
    restriction = SESSION_RESTRICTION_MFA_ENROLLMENT;
  }
  if (restriction && !allowRestrictions.includes(restriction)) throw restrictedSessionError(restriction);

  // support: the session record (not the token) says whether this is a
  // support session; a token that claims impersonation is treated as one too.
  const impersonatedBy = session.impersonatedBy
    ? String(session.impersonatedBy)
    : (payload.impersonation === true && payload.impersonatedBy ? String(payload.impersonatedBy) : null);
  const impersonation = Boolean(session.impersonatedBy) || payload.impersonation === true;

  return {
    id: payload.sub,
    sessionId,
    email: payload.email ?? null,
    // An admin's tenant boundary is its LIVE `tenantScope` (roadmap 2.1), not
    // the claim minted at login, so re-scoping applies on the next request.
    tenantId: isAdmin ? account?.tenantScope ?? null : payload.tenantId ?? null,
    ...(isAdmin ? { adminType: account?.adminType ?? null } : {}),
    expiresAt: Number.isFinite(payload.exp) ? payload.exp * 1000 : null,
    restriction,
    stepUpAt: session.stepUpAt ? new Date(session.stepUpAt).getTime() : null,
    impersonation,
    impersonatedBy,
  };
}

/**
 * support: the error for a write made with a read-only support session.
 *
 * @returns {ApiError}
 */
function impersonationReadOnlyError() {
  return new ApiError(403, 'Support sessions are read-only', {
    code: SUPPORT_ERROR_CODES.IMPERSONATION_READ_ONLY,
  });
}

/**
 * Shared middleware factory. Verifies the JWT against the given audience,
 * enforces session liveness and account/tenant status, and attaches the
 * identity at `req[attach]`. Required (non-optional) guards then apply
 * idempotent-replay protection to mutations carrying `X-Idempotency-Key`.
 *
 * @param {Object} [opts]
 * @param {string} [opts.audience] - required token audience (`user`|`admin`).
 * @param {string} [opts.attach] - request key to attach the identity to.
 * @param {boolean} [opts.optional] - pass through instead of 401 on failure.
 * @param {string[]} [opts.allowRestrictions] - adminauth: restricted
 *   sessions accepted by this guard (default none).
 * @param {boolean} [opts.impersonationOnly] - support: accept ONLY support
 *   sessions, and let them use this one (non-safe) route.
 * @returns {import('express').RequestHandler}
 */
export function authenticateToken({
  audience = JWT_AUDIENCES.USER,
  attach = 'user',
  optional = false,
  allowRestrictions = [],
  impersonationOnly = false,
} = {}) {
  return async (req, res, next) => {
    const token = readBearerToken(req);
    if (!token) {
      return optional ? next() : next(ApiError.unauthorized('Authentication required'));
    }

    let identity;
    try {
      identity = await verifyAccessToken({ token, audience, allowRestrictions });
    } catch (err) {
      if (optional) return next();
      if (err?.denialReason && err.denialReason !== 'token_expired') {
        auditDenied(req, err, err.denialReason);
      }
      return next(err);
    }

    req[attach] = {
      id: identity.id,
      sessionId: identity.sessionId,
      email: identity.email,
      tenantId: identity.tenantId,
      ...(identity.adminType !== undefined ? { adminType: identity.adminType } : {}),
      // adminauth: session restriction and last step-up (epoch ms or null).
      restriction: identity.restriction ?? null,
      stepUpAt: identity.stepUpAt ?? null,
    };
    // support: attribute the support session to its operator, and keep it
    // read-only. The identity is attached first so the access log still
    // records the refused request with the operator id.
    if (identity.impersonation) {
      req[attach].impersonation = true;
      req[attach].impersonatedBy = identity.impersonatedBy;
    }
    if (impersonationOnly && !identity.impersonation) {
      return next(new ApiError(403, 'This endpoint is only for support sessions', {
        code: SUPPORT_ERROR_CODES.IMPERSONATION_SESSION_REQUIRED,
      }));
    }
    if (identity.impersonation && !impersonationOnly && !SAFE_METHODS.has(String(req.method).toUpperCase())) {
      return next(impersonationReadOnlyError());
    }
    // Carry the resolved actor (and request id) through the async context so
    // the audit plugin can attribute model changes to this requester.
    const actor = getActor(req);
    const userAgent = req.headers?.['user-agent'];
    return runWithContext(
      {
        actor,
        requestId: req.id ?? null,
        ip: req.ip ?? null,
        userAgent: typeof userAgent === 'string' ? userAgent : null,
      },
      () => (optional ? next() : replayGuard(req, res, next)),
    );
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

// mfa-tenant: tenant-user guards that also accept a session restricted to
// MFA enrolment (a member the workspace policy requires to use MFA). Only
// the enrolment surface, `/users/me` and logout use them.
/** Require a tenant-user token; an enrolment-only session is accepted. */
export const authenticateAllowEnrollment = authenticateToken({
  audience: JWT_AUDIENCES.USER,
  attach: 'user',
  allowRestrictions: ['mfa_enrollment'],
});

/** Optional variant (logout), enrolment-only sessions included. */
export const optionalAuthenticateAllowEnrollment = authenticateToken({
  audience: JWT_AUDIENCES.USER,
  attach: 'user',
  optional: true,
  allowRestrictions: ['mfa_enrollment'],
});

/**
 * support: authenticate a SUPPORT session (and nothing else) for the one
 * mutation it may perform - ending itself. Every other route keeps support
 * sessions read-only.
 */
export const authenticateImpersonation = authenticateToken({
  audience: JWT_AUDIENCES.USER,
  attach: 'user',
  impersonationOnly: true,
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
      return next(auditDenied(req, ApiError.forbidden('Role information is not available for this identity'), 'no_identity'));
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
      return next(auditDenied(req, ApiError.forbidden('Role information is not available for this identity'), 'role_missing'));
    }
    if (!allowedRoles.some((role) => roles.includes(role))) {
      return next(auditDenied(req, ApiError.forbidden('You do not have permission to perform this action'), 'role_missing', { roles: allowedRoles }));
    }
    return next();
  };
}

export default {
  authenticate,
  optionalAuthenticate,
  authorize,
  authenticateToken,
  verifyAccessToken,
  // support:
  authenticateImpersonation,
  // mfa-tenant
  authenticateAllowEnrollment,
  optionalAuthenticateAllowEnrollment,
};
