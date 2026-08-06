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
 * CODING GUIDELINES
 *   - Async handlers wrapped in `asyncHandler`.
 *   - Never call `res.json` directly; use `ApiResponse`.
 *   - Never touch repositories - the service layer does that.
 *   - Never log credentials, sessions, or tokens.
 */

import env from '../../../config/env.js';
import asyncHandler from '../../../utils/asyncHandler.js';
import ApiResponse from '../../../utils/ApiResponse.js';
import { createChildLogger } from '../../../utils/logger.js';
import { parseExpiresIn } from '../../../utils/jwt.js';
import authService from './auth.service.js';

const logger = createChildLogger({ module: 'controllers/auth' });

const COOKIE = env.security.auth.cookieName;
const REFRESH_TTL_SECONDS = parseExpiresIn(env.security.auth.refreshTokenTtl);
const COOKIE_BASE = {
  httpOnly: true,
  secure: env.security.cookieSecure,
  sameSite: env.security.auth.cookieSameSite.toLowerCase(),
  path: '/',
};

function setRefreshCookie(res, token) {
  res.cookie(COOKIE, token, { ...COOKIE_BASE, maxAge: REFRESH_TTL_SECONDS * 1000 });
}

function clearRefreshCookie(res) {
  res.clearCookie(COOKIE, COOKIE_BASE);
}

/** Refresh token from the cookie first, then the (optional) validated body. */
function readRefreshToken(req) {
  return req.cookies?.[COOKIE] ?? req.validated?.body?.refreshToken ?? null;
}

/** Request context passed through to the service for audit/device meta. */
function requestMeta(req) {
  return {
    ip: req.ip ?? '',
    userAgent: req.headers?.['user-agent'] ?? '',
  };
}

/** Return shape shared by login and refresh. */
function authResultPayload(result) {
  return {
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
    refreshToken: result.refreshToken,
    sessionId: result.sessionId,
    actor: result.actor,
  };
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
      const { email, password, mfaToken } = req.validated.body;
      const result = await authService.login({
        portal,
        email,
        password,
        mfaCode: mfaToken ?? undefined,
        tenantId: portal === 'user' ? (req.tenant?.id ?? null) : null,
        device: {},
        ...requestMeta(req),
      });
      setRefreshCookie(res, result.refreshToken);
      logger.info({ portal, actorId: result.actor.id }, 'login succeeded (controller)');
      return ApiResponse.ok(res, authResultPayload(result), 'Login successful');
    }),

    /** POST /refresh - rotate the refresh token, mint a new access token. */
    refresh: asyncHandler(async (req, res) => {
      const result = await authService.refresh({
        refreshToken: readRefreshToken(req),
        ...requestMeta(req),
      });
      setRefreshCookie(res, result.refreshToken);
      return ApiResponse.ok(res, authResultPayload(result), 'Session refreshed');
    }),

    /** POST /logout - revoke the current session (cookie or body token). */
    logout: asyncHandler(async (req, res) => {
      const result = await authService.logoutByRefreshToken({
        refreshToken: readRefreshToken(req),
        sessionId: req.user?.sessionId ?? null,
        reason: 'logout',
      });
      clearRefreshCookie(res);
      return ApiResponse.ok(res, result, 'Logged out');
    }),

    /** GET /me - current actor profile (behind authenticate/adminAuth). */
    me: asyncHandler(async (req, res) => {
      const actorId = portal === 'admin' ? req.admin.id : req.user.id;
      const profile = await authService.getProfile({ portal, actorId });
      return ApiResponse.ok(res, profile);
    }),
  };
}

export const userAuthController = createAuthController('user');
export const adminAuthController = createAuthController('admin');

export default { createAuthController, userAuthController, adminAuthController };
