/**
 * Idempotency middleware.
 *
 * WHY IT EXISTS
 *   Clients retry. Without server-side idempotency, a retry of the same
 *   request can create duplicate records (invitations, orders, exports) or
 *   write the same audit row twice. When the client sends an
 *   `X-Idempotency-Key` header, this middleware makes the request
 *   replay-safe: the first outcome is stored and every retry with the same
 *   key gets that stored response instead of running the handler again.
 *
 * WHERE IT RUNS
 *   The authenticate / adminAuth middleware (`authenticateToken`) applies it
 *   to every authenticated POST / PUT / PATCH / DELETE right after the
 *   identity is verified, so all mutation routes are covered without
 *   per-route wiring. Public routes (login, refresh, register, ...) are not
 *   covered: there is no verified actor to scope the key to. It can also be
 *   mounted explicitly with `idempotency({ ... })` after an auth middleware.
 *
 * CONTRACT
 *   - Opt-in: requests without the header pass straight through. A header
 *     that is empty, longer than 255 characters or not printable ASCII is
 *     rejected (400 `IDEMPOTENCY_KEY_INVALID`).
 *   - Keys are scoped by actor + tenant (the token's and the requested
 *     `X-Tenant-Id`) + method + path (`scopedKey`), so one client key used
 *     by two actors or against two tenants never collides.
 *   - Only successful (2xx) responses up to 64 KiB are stored, for
 *     `retention.idempotencyDays` (default 24 h). A failed attempt is not
 *     stored, so the client may retry it. Stored bodies are encrypted
 *     (AES-256-GCM, `utils/encryption.js`, per-tenant context) because a
 *     creation response may carry a one-time secret (API key, MFA seed).
 *   - Replays carry `X-Idempotent-Replay: true` and the original status,
 *     content type and body.
 *   - The same key with a different body is refused (422
 *     `IDEMPOTENCY_KEY_REUSED`).
 *   - A duplicate that arrives while the first is still running waits for
 *     it in the same process; on another instance it gets 409
 *     `IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1` (a short lock in the
 *     shared cache).
 *   - Cache failures: fail closed (503) by default; `failOpen: true` lets
 *     the request run unprotected and logs a warning instead.
 */

import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import { ERROR_CODES } from '../config/constants.js';
import { readIdempotencyHeader, scopedKey, fingerprintRequest } from '../utils/idempotency.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import cacheService from '../services/cache.service.js';
import { getActor } from './actor.js';

const DEFAULT_TTL_SEC = Math.max(1, Math.round((env.retention?.idempotencyDays ?? 1) * 24 * 60 * 60));
const DEFAULT_LOCK_TTL_SEC = 300;
const MAX_STORED_BYTES = 64 * 1024;
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const APPLIED = Symbol('idempotencyApplied');

/**
 * Same-process coalescing: storage key -> promise that settles once the
 * first request with that key has finished (and stored its outcome).
 */
const inflight = new Map();

/** Workspace the request targets (`X-Tenant-Id`), e.g. an admin acting on a tenant. */
function requestedTenant(req) {
  const raw = req.headers?.['x-tenant-id'];
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null;
}

/**
 * Actor scope from the verified identity (`req.user` / `req.admin`), plus
 * the workspace the request targets: a platform admin's token carries no
 * tenant, so one client key used against two tenants must not collide.
 */
function defaultScope(req) {
  const actor = getActor(req);
  if (!actor?.id || !actor?.type) return null;
  return {
    actorType: actor.type,
    actorId: String(actor.id),
    tenantId: actor.tenantId ?? null,
    targetTenantId: requestedTenant(req),
  };
}

function typedError(statusCode, message, code) {
  return new ApiError(statusCode, message, { code });
}

/** Path the request was sent to, without the query string. */
function requestPath(req) {
  const url = String(req.originalUrl ?? req.url ?? '');
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function isOutcome(value) {
  return Boolean(value) && typeof value === 'object' && Number.isInteger(value.statusCode) && 'body' in value;
}

/**
 * Build the idempotency middleware.
 *
 * @param {Object} [options]
 * @param {number} [options.ttlSec] - how long outcomes are remembered.
 * @param {number} [options.lockTtlSec=300] - upper bound on how long an
 *   in-progress marker blocks other instances.
 * @param {boolean} [options.failOpen=false] - run unprotected (and log)
 *   instead of 503 when the cache is unavailable.
 * @param {Object} [options.cache] - cache facade with get/set/del/increment
 *   (defaults to `app.locals.cache`, then the shared cache service).
 * @param {(req) => ({ actorType, actorId, tenantId, targetTenantId? }|null)} [options.scopeFn]
 *   - who the key belongs to; requests without a scope are not handled.
 * @returns {import('express').RequestHandler}
 */
export function idempotency(options = {}) {
  const ttlSec = Number.isInteger(options.ttlSec) && options.ttlSec > 0 ? options.ttlSec : DEFAULT_TTL_SEC;
  const lockTtlSec = Number.isInteger(options.lockTtlSec) && options.lockTtlSec > 0
    ? options.lockTtlSec
    : DEFAULT_LOCK_TTL_SEC;
  const failOpen = options.failOpen === true;
  const scopeFn = typeof options.scopeFn === 'function' ? options.scopeFn : defaultScope;

  return async function idempotencyMiddleware(req, res, next) {
    if (!UNSAFE_METHODS.has(String(req.method ?? '').toUpperCase())) return next();
    // Runs at most once per request (a route may stack auth middlewares).
    if (req[APPLIED]) return next();

    const { key: clientKey, invalid } = readIdempotencyHeader(req);
    if (invalid) {
      return next(typedError(
        400,
        'X-Idempotency-Key must be 1-255 printable characters',
        ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
      ));
    }
    if (!clientKey) return next();

    const scope = scopeFn(req);
    if (!scope) return next();
    req[APPLIED] = true;

    const cache = options.cache ?? req.app?.locals?.cache ?? cacheService;
    const storageKey = scopedKey({ scope, method: req.method, path: requestPath(req), clientKey });
    const ctx = {
      cache,
      cryptoContext: { purpose: 'idempotency', tenantId: scope.tenantId ?? 'platform' },
      outcomeKey: `idempotency:${storageKey}`,
      lockKey: `idempotency-lock:${storageKey}`,
      fingerprint: fingerprintRequest(req),
      ttlSec,
      lockTtlSec,
    };
    return handle(req, res, next, ctx, failOpen);
  };
}

/* ------------------------------ internals ------------------------------- */

async function handle(req, res, next, ctx, failOpen) {
  // A duplicate in this process waits for the first, then replays it (or
  // runs itself when the first failed and stored nothing).
  const pending = inflight.get(ctx.outcomeKey);
  if (pending) {
    await pending;
    return handle(req, res, next, ctx, failOpen);
  }

  // Claim the key in this process synchronously, before any await.
  let release;
  const done = new Promise((resolve) => {
    release = resolve;
  });
  inflight.set(ctx.outcomeKey, done);
  const finish = () => {
    if (inflight.get(ctx.outcomeKey) === done) inflight.delete(ctx.outcomeKey);
    release();
  };

  let lockHeld = false;
  try {
    const stored = await readOutcome(ctx);
    if (stored) {
      finish();
      return replayOrRefuse(res, next, stored, ctx.fingerprint);
    }

    // Cross-instance guard: the first INCR wins; others see > 1.
    const holders = await ctx.cache.increment(ctx.lockKey);
    if (holders > 1) {
      const after = await readOutcome(ctx);
      if (!after) await boundOrphanedLock(ctx);
      finish();
      if (after) return replayOrRefuse(res, next, after, ctx.fingerprint);
      res.setHeader('Retry-After', '1');
      return next(typedError(
        409,
        'A request with this idempotency key is still being processed',
        ERROR_CODES.IDEMPOTENCY_IN_PROGRESS,
      ));
    }
    lockHeld = true;
    // Bound the lock's life so a crashed instance cannot block the key.
    await ctx.cache.set(ctx.lockKey, 1, ctx.lockTtlSec);
  } catch (err) {
    if (lockHeld) await safeDel(ctx.cache, ctx.lockKey);
    finish();
    req.log?.warn?.({ err: { message: err?.message } }, 'idempotency cache unavailable');
    if (failOpen) return next();
    return next(ApiError.serviceUnavailable('Idempotency cache is unavailable'));
  }

  captureOutcome(res, async (outcome) => {
    try {
      if (outcome) {
        // Empty bodies (e.g. 204) have nothing to protect.
        const encrypted = outcome.body.length > 0;
        const body = encrypted ? await encrypt(outcome.body, ctx.cryptoContext) : '';
        await ctx.cache.set(
          ctx.outcomeKey,
          { ...outcome, body, encrypted, fingerprint: ctx.fingerprint },
          ctx.ttlSec,
        );
      }
    } catch (err) {
      req.log?.warn?.({ err: { message: err?.message } }, 'idempotency outcome could not be stored');
    } finally {
      await safeDel(ctx.cache, ctx.lockKey);
      finish();
    }
  });
  return next();
}

/**
 * Load and decrypt a stored outcome. An entry that cannot be decrypted (for
 * example after a key change) is treated as absent, so the request runs.
 */
async function readOutcome(ctx) {
  const stored = await ctx.cache.get(ctx.outcomeKey);
  if (!isOutcome(stored)) return null;
  if (!stored.encrypted) return stored;
  try {
    return { ...stored, body: await decrypt(stored.body, ctx.cryptoContext) };
  } catch {
    return null;
  }
}

/**
 * A lock is created by INCR and bounded by the SET that follows it. An
 * instance that died between the two left a lock with no expiry, which
 * would answer 409 for this key forever: give such a lock its TTL.
 */
async function boundOrphanedLock(ctx) {
  try {
    if (typeof ctx.cache.ttl !== 'function') return;
    if ((await ctx.cache.ttl(ctx.lockKey)) === -1) {
      await ctx.cache.set(ctx.lockKey, 1, ctx.lockTtlSec);
    }
  } catch {
    /* best effort: the next contended request tries again */
  }
}

async function safeDel(cache, key) {
  try {
    await cache.del(key);
  } catch {
    /* the lock also expires on its own TTL */
  }
}

/** Replay a stored outcome, unless the key is being reused for another payload. */
function replayOrRefuse(res, next, stored, fingerprint) {
  if (stored.fingerprint && stored.fingerprint !== fingerprint) {
    return next(typedError(
      422,
      'This idempotency key was already used with a different request body',
      ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
    ));
  }
  res.status(stored.statusCode);
  for (const [name, value] of Object.entries(stored.headers ?? {})) res.setHeader(name, value);
  res.setHeader('X-Idempotent-Replay', 'true');
  return res.send(stored.body ?? '');
}

/**
 * Record what the handler sends and report it once the response is done:
 * a storable outcome for a finished 2xx response, otherwise `null`.
 */
function captureOutcome(res, onDone) {
  const originalSend = res.send.bind(res);
  let body = null;
  res.send = function patchedSend(payload) {
    body = serialiseBody(payload);
    return originalSend(payload);
  };

  let settled = false;
  const settle = (outcome) => {
    if (settled) return;
    settled = true;
    res.send = originalSend;
    onDone(outcome);
  };
  res.once('finish', () => {
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    const storable = ok && typeof body === 'string' && Buffer.byteLength(body, 'utf8') <= MAX_STORED_BYTES;
    settle(storable ? { statusCode: res.statusCode, headers: pickHeaders(res), body } : null);
  });
  res.once('close', () => settle(null));
}

/** Safe subset of response headers to replay. */
function pickHeaders(res) {
  const out = {};
  for (const name of ['content-type', 'cache-control']) {
    const value = res.getHeader(name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Objects -> JSON, strings as text. Binary bodies (Buffers, e.g. a file
 * download) return `null`: they are not stored, because replaying them as
 * text would corrupt them; a retry simply runs again.
 */
function serialiseBody(body) {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return null;
  if (body === null || body === undefined) return '';
  if (typeof body === 'object') return JSON.stringify(body);
  return String(body);
}

export default idempotency;
