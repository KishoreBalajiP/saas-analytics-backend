/**
 * Idempotency utilities.
 *
 * WHY IT EXISTS
 *   Network clients retry. Without idempotency, a flaky mobile connection
 *   can cause a customer to be charged twice, an account to be created
 *   twice, or an audit log to record two events for a single user action.
 *   This module is the single source of truth for the idempotency contract.
 *
 * RESPONSIBILITY
 *   - `computeKey(req)` -> deterministic 64-char SHA-256 key for a request.
 *   - `keyFromRaw(raw)` -> build a key from a custom payload.
 *
 * CONTRACT (consumed by `middleware/idempotency.middleware.js` in Sprint 1+)
 *   Clients send `X-Idempotency-Key: <opaque-string>`. The middleware:
 *     1. Computes `computedKey = computeKey(req)`.
 *     2. Looks up `cache.get('idempotency:' + computedKey)`.
 *     3. If a stored outcome exists, replay it (status + body).
 *     4. If not, runs the handler, stores the outcome under a TTL (24 h).
 *
 * DESIGN CONSTRAINTS
 *   - Hashing is SHA-256 (deterministic, fast, constant-size).
 *   - The header takes precedence; without it we fall back to a body hash.
 *   - Never logs the raw header value.
 *
 * HOW TO EXTEND
 *   - Add `tenantId` to the key namespace once `resolveTenant` lands
 *     (Sprint 1) so cross-tenant replays are impossible.
 */

import crypto from 'node:crypto';

const DEFAULT_NAMESPACE = 'idempotency';

/**
 * Compute a deterministic idempotency key for an Express request.
 *
 * Priority:
 *   1. `X-Idempotency-Key` header (the client-chosen token).
 *   2. A SHA-256 of the request method + path + body when the header is
 *      absent. Suitable for same-process retries; not safe across tenants.
 *
 * @param {import('express').Request} req - Express request.
 * @returns {string} 64-character hex digest.
 */
export function computeKey(req) {
  const header = readHeader(req);
  if (header) {
    return sha256Hex(`${DEFAULT_NAMESPACE}:header:${header}`);
  }
  const body = normaliseBody(req?.body);
  const method = String(req?.method ?? 'GET').toUpperCase();
  const path = String(req?.originalUrl ?? req?.url ?? '');
  const fingerprint = `${method}:${path}:${body}`;
  return sha256Hex(`${DEFAULT_NAMESPACE}:fingerprint:${fingerprint}`);
}

/**
 * Build an idempotency key from a raw string. Use when the caller already
 * has a stable identifier (e.g. `tenantId:orderId`).
 *
 * @param {string} raw - the raw token (must be a non-empty string).
 * @returns {string} 64-character hex digest.
 */
export function keyFromRaw(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('keyFromRaw requires a non-empty string');
  }
  return sha256Hex(`${DEFAULT_NAMESPACE}:raw:${raw}`);
}

/* ------------------------------ internals ------------------------------- */

/**
 * Read the idempotency header from a request, tolerant of header casing in
 * Express 5 (which lower-cases header names internally).
 *
 * @param {import('express').Request} req
 * @returns {string|null} raw header value or null.
 */
function readHeader(req) {
  const value = req?.headers?.['x-idempotency-key'];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return null;
  return trimmed;
}

/**
 * Produce a stable string representation of the request body. Objects are
 * serialised with sorted keys so cosmetic differences (key order) do not
 * produce different fingerprints.
 *
 * @param {*} body
 * @returns {string}
 */
function normaliseBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  return stableStringify(body);
}

/**
 * JSON serialise with sorted keys at every level.
 *
 * @param {*} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`;
}

/**
 * SHA-256 a string and return the hex digest.
 *
 * @param {string} value
 * @returns {string}
 */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export default { computeKey, keyFromRaw };
