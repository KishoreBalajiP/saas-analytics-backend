/**
 * Auth Controller (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Thin HTTP layer for login / refresh / logout / me on BOTH portals.
 *   A single factory drives the tenant portal (`/auth/*`) and the admin
 *   portal (`/admin-auth/*`) - the only difference is the portal the
 *   service layer is told to use. All business rules live in
 *   `auth.service.js` / `session.service.js`.
 *
 * RESPONSIBILITY
 *   - Read validated input + request context (IP / user agent / cookies).
 *   - Call the auth service.
 *   - Set/clear the HttpOnly refresh-token cookie.
 *   - Shape the success envelope via `ApiResponse`.
 *
 * TOKEN TRANSPORT
 *   - The refresh token travels ONLY in an HttpOnly cookie. Login and
 *     refresh bodies carry the access token, its lifetime and the actor
 *     summary - never the refresh token or the session id.
 *   - Each portal has its own cookie name AND path (`<prefix>/auth` vs
 *     `<prefix>/admin-auth`), so the browser only sends a portal's cookie
 *     to that portal and signing in to one never replaces the other.
 *   - Before the split both portals shared one cookie at path `/`. That
 *     legacy cookie is still read as a fallback (the service enforces the
 *     portal) and is cleared once replaced, so nobody is logged out by the
 *     migration and a stale copy can never be replayed.
 *
 * CODING GUIDELINES
 *   - Async handlers wrapped in `asyncHandler`.
 *   - Never call `res.json` directly; use `ApiResponse`.
 *   - Never touch repositories - the service layer does that.
 *   - Never log credentials, sessions, or tokens.
 */

import env from '../../../config/env.js';
import asyncHandler from '../../../utils/asyncHandler.js';
import ApiResponse from '../../../utils/ApiResponse.js';
import ApiError from '../../../utils/ApiError.js';
import { createChildLogger } from '../../../utils/logger.js';
import { parseExpiresIn } from '../../../utils/jwt.js';
import authService from './auth.service.js';

const logger = createChildLogger({ module: 'controllers/auth' });

const AUTH = env.security.auth;
const REFRESH_TTL_SECONDS = parseExpiresIn(AUTH.refreshTokenTtl);

/** Shared attributes; `domain` only for first-party (parent-domain) setups. */
const COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: env.security.cookieSecure,
  sameSite: AUTH.cookieSameSite.toLowerCase(),
  ...(AUTH.cookieDomain ? { domain: AUTH.cookieDomain } : {}),
};

/** Per-portal refresh cookie: distinct name and path. */
export const PORTAL_COOKIES = Object.freeze({
  user: Object.freeze({ name: AUTH.cookieName, path: `${env.app.apiPrefix}/auth` }),
  admin: Object.freeze({ name: AUTH.adminCookieName, path: `${env.app.apiPrefix}/admin-auth` }),
});

/** The pre-split cookie both portals used to share (host-only, path `/`). */
const LEGACY_COOKIE = Object.freeze({
  name: AUTH.cookieName,
  options: Object.freeze({
    httpOnly: true,
    secure: env.security.cookieSecure,
    sameSite: AUTH.cookieSameSite.toLowerCase(),
    path: '/',
  }),
});

function cookieOptions(portal) {
  return { ...COOKIE_ATTRIBUTES, path: PORTAL_COOKIES[portal].path };
}

/** Cookie lifetime follows the session's own (absolute-capped) expiry. */
function cookieMaxAgeMs(expiresAt) {
  const remaining = expiresAt ? new Date(expiresAt).getTime() - Date.now() : NaN;
  if (Number.isFinite(remaining) && remaining > 0) return remaining;
  return REFRESH_TTL_SECONDS * 1000;
}

function setRefreshCookie(res, portal, token, expiresAt) {
  res.cookie(PORTAL_COOKIES[portal].name, token, { ...cookieOptions(portal), maxAge: cookieMaxAgeMs(expiresAt) });
}

function clearRefreshCookie(res, portal) {
  res.clearCookie(PORTAL_COOKIES[portal].name, cookieOptions(portal));
}

/**
 * Drop the legacy shared cookie. The tenant portal always replaces it (it
 * has the same name, so a stale copy must never shadow the new one); the
 * admin portal only clears it when the admin session was read from it.
 */
function clearLegacyCookie(req, res, portal, { consumed = false } = {}) {
  if (!req.cookies?.[LEGACY_COOKIE.name]) return;
  if (portal === 'admin' && !consumed) return;
  res.clearCookie(LEGACY_COOKIE.name, LEGACY_COOKIE.options);
}

/**
 * Refresh token from this portal's cookie (falling back to the legacy shared
 * cookie). Request bodies are never read: the token is cookie-only.
 *
 * @returns {{ token: string|null, legacy: boolean }}
 */
function readRefreshToken(req, portal) {
  const own = req.cookies?.[PORTAL_COOKIES[portal].name];
  if (typeof own === 'string' && own.length > 0) return { token: own, legacy: false };
  const legacy = req.cookies?.[LEGACY_COOKIE.name];
  if (typeof legacy === 'string' && legacy.length > 0) return { token: legacy, legacy: true };
  return { token: null, legacy: false };
}

/** Request context passed through to the service for audit/device meta. */
function requestMeta(req) {
  return {
    ip: req.ip ?? '',
    userAgent: req.headers?.['user-agent'] ?? '',
  };
}

/**
 * Return shape shared by login and refresh. Deliberately excludes the
 * refresh token and the session id: they live in the HttpOnly cookie only.
 * `sessionExpiresAt` (not a secret) tells the client how long the cookie
 * should live, so it can tell a blocked cookie from an expired one.
 */
function authResultPayload(result) {
  return {
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
    sessionExpiresAt: result.refreshExpiresAt ? new Date(result.refreshExpiresAt).toISOString() : null,
    actor: result.actor,
    // adminauth: the session may only enrol MFA; and how many recovery
    // codes are left after signing in with one.
    ...(result.mfaEnrollmentRequired ? { mfaEnrollmentRequired: true } : {}),
    ...(result.recoveryCodesRemaining !== undefined ? { recoveryCodesRemaining: result.recoveryCodesRemaining } : {}),
  };
}

/**
 * adminauth: answer a request that started a session outside `/login` (an
 * accepted admin invitation): set the portal's refresh cookie and return the
 * usual login payload.
 *
 * @param {import('express').Response} res
 * @param {'user'|'admin'} portal
 * @param {Object} result - `authService.startSession` result.
 * @param {string} [message]
 */
export function respondWithSession(res, portal, result, message = 'Signed in') {
  setRefreshCookie(res, portal, result.refreshToken, result.refreshExpiresAt);
  return ApiResponse.ok(res, authResultPayload(result), message);
}

/**
 * Build the controller for one portal.
 *
 * @param {'user'|'admin'} portal
 * @returns {Object} `{ login, refresh, logout, me }` Express handlers.
 */
export function createAuthController(portal) {
  return {
    /** POST /login - exchange credentials for a session + tokens. */
    login: asyncHandler(async (req, res) => {
      const { email, password, mfaToken, recoveryCode } = req.validated.body;
      const result = await authService.login({
        portal,
        email,
        password,
        mfaCode: mfaToken ?? undefined,
        // mfa-tenant: both portals accept a one-time recovery code.
        recoveryCode: recoveryCode ?? undefined,
        tenantId: portal === 'user' ? (req.tenant?.id ?? null) : null,
        device: {},
        ...requestMeta(req),
      });
      setRefreshCookie(res, portal, result.refreshToken, result.refreshExpiresAt);
      // Attributes this request's access-log row to the account that signed in.
      res.locals.authActor = { type: portal, id: result.actor.id, tenantId: result.tenantId ?? null };
      // A fresh tenant login supersedes any legacy shared cookie.
      if (portal === 'user') clearLegacyCookie(req, res, portal);
      logger.info({ portal, actorId: result.actor.id }, 'login succeeded (controller)');
      return ApiResponse.ok(res, authResultPayload(result), 'Login successful');
    }),

    /** POST /refresh - rotate the refresh token, mint a new access token. */
    refresh: asyncHandler(async (req, res) => {
      const { token, legacy } = readRefreshToken(req, portal);
      let result;
      try {
        result = await authService.refresh({
          refreshToken: token,
          portal,
          ...requestMeta(req),
        });
      } catch (err) {
        // A dead session cookie is useless to the client; drop it so the
        // browser stops presenting it. (Never the other portal's cookie.)
        if (err?.statusCode === 401 && token && !legacy) clearRefreshCookie(res, portal);
        throw err;
      }
      // No new refresh token means this request lost a concurrent rotation
      // race: the winning response already set the successor's cookie, so
      // leave the cookie alone.
      if (result.refreshToken) {
        setRefreshCookie(res, portal, result.refreshToken, result.refreshExpiresAt);
        clearLegacyCookie(req, res, portal, { consumed: legacy });
      }
      return ApiResponse.ok(res, authResultPayload(result), 'Session refreshed');
    }),

    /**
     * POST /logout - revoke the current session. Works from the refresh
     * cookie, the bearer access token (verified by the optional auth
     * middleware), or both, and reports whether anything was revoked.
     */
    logout: asyncHandler(async (req, res) => {
      const { token, legacy } = readRefreshToken(req, portal);
      const identity = portal === 'admin' ? req.admin : req.user;
      const result = await authService.logoutByRefreshToken({
        refreshToken: token,
        sessionId: identity?.sessionId ?? null,
        portal,
        reason: 'logout',
      });
      clearRefreshCookie(res, portal);
      clearLegacyCookie(req, res, portal, { consumed: legacy });
      return ApiResponse.ok(res, result, result.revoked ? 'Logged out' : 'No active session to revoke');
    }),

    /** GET /me - current actor profile (behind authenticate/adminAuth). */
    me: asyncHandler(async (req, res) => {
      const actorId = portal === 'admin' ? req.admin.id : req.user.id;
      const identity = portal === 'admin' ? req.admin : req.user;
      const profile = await authService.getProfile({
        portal,
        actorId,
        session: { restriction: identity.restriction ?? null, stepUpAt: identity.stepUpAt ?? null },
      });
      return ApiResponse.ok(res, profile);
    }),

    register: asyncHandler(async (req, res) => {
      const { fullName, email, password, workspaceName, workspaceSlug, acceptTerms, termsVersion } = req.validated.body;
      const result = await authService.register({
        fullName,
        email,
        password,
        workspaceName,
        workspaceSlug,
        // onboarding: consent recorded with the user.
        acceptTerms,
        termsVersion,
        ip: req.ip ?? null,
      });
      return ApiResponse.created(res, result, 'Workspace created. Check your email to verify your account.');
    }),

    verifyEmail: asyncHandler(async (req, res) => {
      const { token } = req.validated.body;
      const result = await authService.verifyEmail({ token });
      return ApiResponse.ok(res, result, 'Email verified successfully');
    }),

    resendVerification: asyncHandler(async (req, res) => {
      const { email } = req.validated.body;
      const tenantIdentifier = req.headers?.['x-tenant-id'];
      if (!tenantIdentifier) throw ApiError.badRequest('Workspace slug is required');
      const result = await authService.resendVerification({
        tenantIdentifier,
        email,
      });
      return ApiResponse.ok(
        res,
        result,
        'If an unverified account exists for that email, a new verification link has been sent.',
      );
    }),
  };
}

export const userAuthController = createAuthController('user');
export const adminAuthController = createAuthController('admin');

export default { createAuthController, userAuthController, adminAuthController, PORTAL_COOKIES, respondWithSession };
