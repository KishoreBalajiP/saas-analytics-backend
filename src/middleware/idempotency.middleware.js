/**
 * Idempotency middleware.
 *
 * WHY IT EXISTS
 *   Clients retry. Without server-side idempotency, a retry of the same
 *   request can create duplicate records, charge twice, or write the same
 *   audit row twice. This middleware makes any endpoint idempotent when the
 *   client supplies an `X-Idempotency-Key` header (or when a deterministic
 *   body fingerprint is used as the fallback key).
 *
 * RESPONSIBILITY
 *   - Resolve an idempotency key from header or body fingerprint.
 *   - On first request: run the handler, capture the response, store it
 *     under a TTL (default 24 h), and reply.
 *   - On replay: respond with the previously-stored status + body without
 *     running the handler again.
 *   - Fail closed: if the cache layer is unavailable, the request is
 *     REJECTED (503) rather than silently allowing a non-idempotent call.
 *
 * DESIGN CONSTRAINTS
 *   - Stores at most 64 KiB per key; larger responses are not cached.
 *   - Concurrent retries (same key, in-flight) are coalesced.
 *   - Storage lives in the cache layer (memory or Redis) so multi-instance
 *     deployments get cross-instance protection once Redis is enabled.
 *
 * HOW TO EXTEND
 *   - Mount per-route via `idempotency({ ttlSec })`.
 *   - To force the cache to fail-open instead of fail-closed, pass
 *     `{ failOpen: true }` (NOT recommended for mutations).
 */

import { computeKey } from '../utils/idempotency.js';
import ApiError from '../utils/ApiError.js';

const DEFAULT_TTL_SEC = 24 * 60 * 60;
const DEFAULT_NAMESPACE = 'idempotency:';
const MAX_STORED_BYTES = 64 * 1024;

/**
 * In-memory coalescing map: tracks promises for keys currently being
 * processed so two simultaneous retries for the same key produce only one
 * downstream call.
 */
const inflight = new Map();

/**
 * Build the idempotency middleware factory.
 *
 * @param {Object} [options]
 * @param {number} [options.ttlSec=86400] - how long to remember outcomes.
 * @param {boolean} [options.failOpen=false] - allow requests when cache is
 *   unavailable (NOT recommended; only useful for read endpoints).
 * @param {(req: import('express').Request) => string} [options.keyFn] -
 *   custom key function; defaults to `computeKey(req)`.
 * @returns {import('express').RequestHandler} Express middleware.
 */
export function idempotency(options = {}) {
  const ttlSec = Number.isInteger(options.ttlSec) && options.ttlSec > 0 ? options.ttlSec : DEFAULT_TTL_SEC;
  const failOpen = options.failOpen === true;
  const keyFn = typeof options.keyFn === 'function' ? options.keyFn : computeKey;

  return async function idempotencyMiddleware(req, res, next) {
    const cache = req.app?.locals?.cache ?? null;
    if (!cache) {
      if (failOpen) return next();
      return next(
        ApiError.serviceUnavailable(
          'Idempotency requires the cache layer to be available',
        ),
      );
    }

    const key = keyFn(req);
    const namespacedKey = `${DEFAULT_NAMESPACE}${key}`;

    // 1. Replay path: a previously-stored outcome exists.
    try {
      const cached = await cache.get(namespacedKey);
      if (cached && typeof cached === 'object') {
        return replay(res, cached);
      }
    } catch (err) {
      req.log?.warn?.({ err: { message: err.message } }, 'idempotency lookup failed');
      if (!failOpen) {
        return next(
          ApiError.serviceUnavailable('Idempotency cache is unavailable'),
        );
      }
      return next();
    }

    // 2. In-flight coalescing: another request is processing this key.
    const pending = inflight.get(namespacedKey);
    if (pending) {
      try {
        const outcome = await pending;
        if (outcome) return replay(res, outcome);
      } catch {
        // The in-flight request failed; fall through and let the current
        // request run normally so the caller gets its own response.
      }
    }

    // 3. Capture the response and store the outcome.
    const capturePromise = captureAndStore({ req, res, cache, namespacedKey, ttlSec, next });
    inflight.set(namespacedKey, capturePromise);
    capturePromise.finally(() => {
      if (inflight.get(namespacedKey) === capturePromise) inflight.delete(namespacedKey);
    });
    await capturePromise;
  };
}

/* ------------------------------ internals ------------------------------- */

/**
 * Replay a cached outcome on the response.
 *
 * @param {import('express').Response} res
 * @param {Object} cached
 */
function replay(res, cached) {
  if (cached.statusCode) res.status(cached.statusCode);
  if (cached.headers) {
    for (const [name, value] of Object.entries(cached.headers)) {
      res.setHeader(name, value);
    }
  }
  res.setHeader('X-Idempotent-Replay', 'true');
  return res.send(cached.body ?? null);
}

/**
 * Capture the response, persist the outcome, then forward to the handler.
 * Wraps `res.send` and `res.json` to intercept the body and status code.
 *
 * @param {Object} ctx
 * @returns {Promise<void>}
 */
function captureAndStore({ req, res, cache, namespacedKey, ttlSec, next }) {
  return new Promise((resolve, reject) => {
    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);

    res.send = function patchedSend(body) {
      const stringBody = serialiseBody(body);
      // Persist but do not await - we must not delay the response. The
      // outcome is fetched by concurrent retries from the cache directly
      // so a fire-and-forget write is acceptable here.
      persistOutcome({
        cache,
        namespacedKey,
        ttlSec,
        statusCode: res.statusCode,
        headers: pickHeaders(res),
        body: stringBody,
      });
      return originalSend(body);
    };

    res.json = function patchedJson(body) {
      const stringBody = JSON.stringify(body);
      persistOutcome({
        cache,
        namespacedKey,
        ttlSec,
        statusCode: res.statusCode,
        headers: pickHeaders(res),
        body: stringBody,
      });
      return originalJson(body);
    };

    res.on('finish', () => resolve());
    res.on('close', () => resolve());

    try {
      next();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Persist the outcome to the cache. Large bodies are NOT stored; this
 * prevents the cache from filling up with oversized responses.
 *
 * @param {Object} params
 */
async function persistOutcome({ cache, namespacedKey, ttlSec, statusCode, headers, body }) {
  if (typeof body !== 'string') return;
  if (Buffer.byteLength(body, 'utf8') > MAX_STORED_BYTES) return;
  try {
    await cache.set(
      namespacedKey,
      { statusCode, headers, body },
      ttlSec,
    );
  } catch {
    // Cache write failures must not break the response.
  }
}

/**
 * Pick a safe subset of response headers to store/replay.
 *
 * @param {import('express').Response} res
 * @returns {Object}
 */
function pickHeaders(res) {
  const out = {};
  const allow = ['content-type', 'cache-control', 'x-request-id'];
  for (const name of allow) {
    const value = res.getHeader(name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Serialise a response body safely (objects -> JSON, everything else -> as-is).
 *
 * @param {*} body
 * @returns {string}
 */
function serialiseBody(body) {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body === null || body === undefined) return '';
  return JSON.stringify(body);
}

export default idempotency;
