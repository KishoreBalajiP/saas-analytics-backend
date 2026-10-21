/**
 * Rate limiter middleware.
 *
 * WHY IT EXISTS
 *   Protects the API from abuse and accidental client bugs with a sliding
 *   window limit per IP, configured entirely through environment variables.
 *
 * RESPONSIBILITY
 *   - Apply a global per-IP limit to all API routes (health excluded so
 *     load balancers can probe freely).
 *   - Provide a factory for stricter per-feature limits.
 *   - Provide one limiter per auth route class and portal (login, refresh,
 *     password forgot/reset, registration, email verification, MFA,
 *     invitations), each with its OWN bucket, so refresh traffic or one
 *     portal can never exhaust another route's budget.
 *   - Key credential routes by client IP plus the account identifier (email
 *     and workspace), with an additional per-IP ceiling on login. Refresh is
 *     keyed by IP plus a digest of the presented refresh cookie.
 *   - Share counters across instances through Redis when `REDIS_URL` is set
 *     (`rate-limit-redis`); otherwise each limiter keeps an in-memory store.
 *   - Return a typed 429 (`code: RATE_LIMITED`) with a `Retry-After` header
 *     and `meta.retryAfterSeconds`.
 *
 * DESIGN NOTES
 *   - Account identifiers are hashed before they become store keys, so
 *     emails never appear in Redis.
 *   - Store errors fail open (`passOnStoreError`): a Redis outage must not
 *     lock everyone out. Account lockout is persisted in MongoDB and still
 *     applies.
 *   - `req.ip` honours `TRUST_PROXY`; set it to the real hop count, or a
 *     client can spoof `X-Forwarded-For`.
 *
 * HOW TO EXTEND
 *   Create per-endpoint limiters with `createRateLimiter({ name, windowMs,
 *   limit, keyGenerator })` at module load and mount them inside specific
 *   routers. Every limiter needs a unique `name` (it prefixes its keys).
 */

import { createHash } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import { ERROR_CODES } from '../config/constants.js';

/* ------------------------------ redis store ------------------------------ */

let redisClient = null;

/** One lazily-connected ioredis client shared by every Redis-backed limiter. */
function getRedisClient() {
  if (!redisClient) {
    redisClient = new Redis(env.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    // ioredis throws on an unhandled 'error' event; connection trouble must
    // degrade to "limiter skipped" (passOnStoreError), never a crash.
    redisClient.on('error', (err) => {
      logger.warn({ err: { message: err.message } }, 'Rate-limit Redis connection error');
    });
  }
  return redisClient;
}

/**
 * Close the shared rate-limit Redis connection (graceful shutdown, see
 * `jobs/shutdown.js`). A no-op without Redis; a connection that never became
 * ready is dropped instead of sending QUIT.
 */
export async function closeRateLimitStore() {
  const client = redisClient;
  redisClient = null;
  if (!client) return;
  if (client.status !== 'ready') {
    client.disconnect?.();
    return;
  }
  try {
    await client.quit();
  } catch {
    client.disconnect?.();
  }
}

/**
 * Build the backing store for one limiter: Redis when configured (counters
 * shared across instances), otherwise `undefined` so express-rate-limit
 * creates a private in-memory store for this limiter.
 *
 * @param {string} name - unique limiter name (key prefix).
 * @returns {Object|undefined}
 */
function createStore(name) {
  if (!env.redis.enabled || !env.redis.url) return undefined;
  const client = getRedisClient();
  const store = new RedisStore({
    prefix: `rl:${name}:`,
    sendCommand: (command, ...args) => client.call(command, ...args),
  });
  // The store starts loading its Lua scripts in the constructor. A failure
  // there is retried on first use; never let it surface as an unhandled
  // rejection.
  store.incrementScriptSha?.catch?.(() => {});
  store.getScriptSha?.catch?.(() => {});
  return store;
}

/* -------------------------------- handler -------------------------------- */

/** Typed 429 envelope. `Retry-After` is set by express-rate-limit. */
function createHandler(name) {
  return (req, res, _next, options) => {
    const header = Number(res.getHeader('Retry-After'));
    const retryAfterSeconds = Number.isFinite(header) && header > 0
      ? header
      : Math.ceil(options.windowMs / 1000);
    if (!res.getHeader('Retry-After')) res.setHeader('Retry-After', String(retryAfterSeconds));
    if (req.log) {
      req.log.warn({ ip: req.ip, limiter: name }, 'Rate limit exceeded');
    }
    res.status(429).json({
      success: false,
      statusCode: 429,
      message: 'Too many requests, please try again later.',
      code: ERROR_CODES.RATE_LIMITED,
      errors: null,
      meta: { retryAfterSeconds, limiter: name },
      timestamp: new Date().toISOString(),
    });
  };
}

/* ------------------------------ key helpers ------------------------------ */

/** Short, stable digest so identifiers never appear raw in store keys. */
function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

/** Client IP (honours the configured trust-proxy hop count). */
export function ipKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** Lower-cased, trimmed email from the raw JSON body (limiters run before validation). */
function bodyEmail(req) {
  const email = req.body?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** Workspace identifier the tenant portal sends on credential routes. */
function workspaceHeader(req) {
  const value = req.headers?.['x-tenant-id'];
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * IP plus the account being targeted (email + workspace). Falls back to the
 * IP alone when the request names no account (validation rejects it next).
 */
export function accountKey(req) {
  const email = bodyEmail(req);
  if (!email) return ipKey(req);
  return `${ipKey(req)}|${digest(`${workspaceHeader(req)}|${email}`)}`;
}

/** Refresh-cookie names per portal (the legacy shared cookie is the tenant name). */
const REFRESH_COOKIES = Object.freeze({
  user: [env.security.auth.cookieName],
  admin: [env.security.auth.adminCookieName, env.security.auth.cookieName],
});

/**
 * IP plus the refresh session being presented, so every signed-in browser
 * behind one NAT has its own refresh budget. Without a cookie the IP alone
 * is the key. Cookie spraying from one IP is still capped by `apiLimiter`.
 *
 * @param {'user'|'admin'} portal
 */
function refreshKey(portal) {
  return (req) => {
    for (const name of REFRESH_COOKIES[portal]) {
      const value = req.cookies?.[name];
      if (typeof value === 'string' && value.length > 0) return `${ipKey(req)}|${digest(value)}`;
    }
    return ipKey(req);
  };
}

/** The signed-in admin (MFA routes run after `adminAuth`), else the IP. */
function adminKey(req) {
  // mfa-tenant: tenant MFA routes run after `authenticate`; key them by user.
  if (!req.admin?.id && req.user?.id) return `user:${req.user.id}`;
  return req.admin?.id ? `admin:${req.admin.id}` : ipKey(req);
}

/* -------------------------------- factory -------------------------------- */

/** Shared defaults so every limiter behaves consistently. */
const baseOptions = {
  windowMs: env.security.rateLimit.windowMs,
  limit: env.security.rateLimit.max,
  standardHeaders: true, // send `RateLimit-*` (draft-7) headers
  legacyHeaders: false, // drop the deprecated `X-RateLimit-*` headers
  skip: (req) => req.path === '/health' || req.path.startsWith('/health'),
  passOnStoreError: true,
};

let anonymousLimiterCount = 0;

/**
 * Factory for feature-specific limiters. Each call gets its own bucket.
 *
 * @param {Object} [opts]
 * @param {string} [opts.name] - unique name; prefixes the store keys.
 * @param {number} [opts.windowMs]
 * @param {number} [opts.limit]
 * @param {(req: import('express').Request) => string} [opts.keyGenerator]
 * @param {(req: import('express').Request) => boolean} [opts.skip]
 * @returns {import('express').RequestHandler}
 */
export function createRateLimiter({ name, windowMs, limit, keyGenerator, skip } = {}) {
  anonymousLimiterCount += 1;
  const limiterName = name ?? `limiter-${anonymousLimiterCount}`;
  const store = createStore(limiterName);
  return rateLimit({
    ...baseOptions,
    windowMs: windowMs ?? env.security.rateLimit.windowMs,
    limit: limit ?? env.security.rateLimit.strictMax,
    keyGenerator: keyGenerator ?? ipKey,
    skip,
    ...(store ? { store } : {}),
    handler: createHandler(limiterName),
  });
}

const apiStore = createStore('api');

/** Global API limiter applied to every request under the API prefix. */
export const apiLimiter = rateLimit({
  ...baseOptions,
  ...(apiStore ? { store: apiStore } : {}),
  handler: createHandler('api'),
});

/** Generic strict limiter (public access-request submissions). */
export const strictLimiter = createRateLimiter({
  name: 'strict',
  windowMs: env.security.rateLimit.windowMs,
  limit: env.security.rateLimit.strictMax,
});

/* ------------------------------ auth surface ----------------------------- */

const AUTH_LIMITS = env.security.authRateLimit;

/**
 * Build the per-route limiters for one portal. Names include the portal so
 * the tenant and admin portals never share a bucket.
 *
 * @param {'user'|'admin'} portal
 */
function createAuthLimiters(portal) {
  const windowMs = AUTH_LIMITS.windowMs;
  const make = (route, limit, keyGenerator) =>
    createRateLimiter({ name: `${portal}-${route}`, windowMs, limit, keyGenerator });
  return Object.freeze({
    /** Login: a per-IP ceiling plus a tighter per-IP-and-account bucket. */
    login: [make('login-ip', AUTH_LIMITS.loginIpMax, ipKey), make('login', AUTH_LIMITS.loginMax, accountKey)],
    /** Refresh: its own (looser) bucket per IP + session; never shared with login. */
    refresh: make('refresh', AUTH_LIMITS.refreshMax, refreshKey(portal)),
    passwordForgot: make('password-forgot', AUTH_LIMITS.passwordMax, accountKey),
    passwordReset: make('password-reset', AUTH_LIMITS.passwordMax, ipKey),
    register: make('register', AUTH_LIMITS.registerMax, ipKey),
    verifyEmail: make('verify-email', AUTH_LIMITS.verificationMax, ipKey),
    // Per IP: the verification service already enforces a per-account
    // resend cooldown, so this bucket caps one client spraying many emails.
    resendVerification: make('resend-verification', AUTH_LIMITS.verificationMax, ipKey),
    mfa: make('mfa', AUTH_LIMITS.mfaMax, adminKey),
  });
}

/** Tenant-portal (`/auth/*`) limiters. */
export const userAuthLimiters = createAuthLimiters('user');

/** Admin-portal (`/admin-auth/*`) limiters. */
export const adminAuthLimiters = createAuthLimiters('admin');

/** Public invitation preview/accept (one flow, one per-IP bucket). */
export const invitationLimiter = createRateLimiter({
  name: 'invitation',
  windowMs: AUTH_LIMITS.windowMs,
  limit: AUTH_LIMITS.invitationMax,
  keyGenerator: ipKey,
});
