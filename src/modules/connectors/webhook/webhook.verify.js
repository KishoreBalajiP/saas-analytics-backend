/**
 * Webhook signature verification.
 *
 * WHY IT EXISTS
 *   The inbound webhook endpoint (`POST /webhooks/:webhookToken`) is public -
 *   anyone who knows the token can reach it. Every payload MUST be
 *   authenticated with an HMAC-SHA256 signature so a leaked/guessed URL
 *   cannot be used to inject rows. Verification is constant-time so timing
 *   attacks do not leak the signing secret.
 *
 * HEADER CONTRACT (signature version 2 - every new connector)
 *   - `X-Saas-Timestamp: <unix epoch seconds>` - REQUIRED.
 *   - `X-Saas-Signature: v2=<hex>` where
 *       hex = HMAC-SHA256(signingSecret, `${timestamp}.${rawBody}`)
 *     i.e. the timestamp, a literal `.`, then the EXACT raw body bytes.
 *   The timestamp must be within the connector's tolerance window (default
 *   300 s, at most 60 s in the future). Because the timestamp is signed it
 *   cannot be refreshed by a replayer, and a delivery replayed INSIDE the
 *   window is refused by the replay store (`webhook.replay.js`).
 *
 * LEGACY CONTRACT (signature version 1 - connectors created before v2)
 *   - `X-Saas-Signature: sha256=<hex>` over the raw body only, optional
 *     timestamp (required when the connector config sets `requireTimestamp`).
 *   Accepted only for version-1 connectors and only while
 *   `WEBHOOK_LEGACY_SIGNATURES_ENABLED=true`. A version-1 connector also
 *   accepts `v2=` signatures, so a sender can switch before the connector
 *   is upgraded.
 *
 * COST ORDER
 *   `precheckWebhookHeaders` validates header presence, format and the
 *   timestamp window WITHOUT the secret, so malformed or stale requests are
 *   refused before the service derives (or looks up) the signing key.
 *
 * FAIL CLOSED
 *   Missing/malformed signature, unknown scheme, missing / malformed /
 *   out-of-window timestamp and mismatch all fail with a
 *   `WebhookSignatureError` (401) carrying a specific `code`.
 *
 * @module webhook-verify
 */

import crypto from 'node:crypto';
import { WebhookSignatureError, CONNECTOR_ERROR_CODES as CODES } from '../shared/errors.js';

export const DEFAULT_TOLERANCE_SECONDS = 300;
/** How far in the future a timestamp may be (clock skew allowance). */
export const MAX_FUTURE_SKEW_SECONDS = 60;
export const SIGNATURE_HEADER = 'x-saas-signature';
export const TIMESTAMP_HEADER = 'x-saas-timestamp';
export const SIGNATURE_VERSIONS = Object.freeze({ LEGACY: 1, TIMESTAMPED: 2 });
/** Version given to every new webhook connector. */
export const CURRENT_SIGNATURE_VERSION = SIGNATURE_VERSIONS.TIMESTAMPED;
const EXPECTED_ALGO = 'sha256';
const V2_TAG = 'v2';
const HEX64 = /^[0-9a-f]{64}$/i;

/* --------------------------------- signing -------------------------------- */

/** Bytes covered by a v2 signature: `${timestamp}.` followed by the raw body. */
export function signedPayload(timestamp, rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
}

/**
 * Compute the v2 `X-Saas-Signature` value (what senders must send).
 *
 * @param {Object} opts
 * @param {number|string} opts.timestamp - unix epoch seconds (the X-Saas-Timestamp value).
 * @param {Buffer|string} opts.rawBody - the EXACT request body bytes.
 * @param {string} opts.secret - the connector's signing secret.
 * @returns {string} `v2=<hex>`.
 */
export function computeTimestampedSignature({ timestamp, rawBody, secret }) {
  const hmac = crypto.createHmac('sha256', secret).update(signedPayload(timestamp, rawBody)).digest('hex');
  return `${V2_TAG}=${hmac}`;
}

/**
 * Compute the LEGACY (version 1) `X-Saas-Signature` value over the raw body.
 *
 * @param {Buffer|string} rawBody - the EXACT request body bytes.
 * @param {string} secret - the connector's signing secret.
 * @returns {string} `sha256=<hex>`.
 */
export function computeSignature(rawBody, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  return `${EXPECTED_ALGO}=${hmac.digest('hex')}`;
}

/* ------------------------------ pre-checks -------------------------------- */

/**
 * Parse `X-Saas-Signature`. Several comma-separated values are allowed
 * (e.g. `v2=...,sha256=...` while a sender migrates).
 *
 * @returns {Array<{ version: 1|2, hex: string }>}
 * @throws {WebhookSignatureError} missing or malformed header.
 */
export function parseSignatureHeader(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WebhookSignatureError('Missing X-Saas-Signature header', CODES.WEBHOOK_SIGNATURE_MISSING);
  }
  if (value.length > 1024) {
    throw new WebhookSignatureError('Malformed X-Saas-Signature header', CODES.WEBHOOK_SIGNATURE_MALFORMED);
  }
  const candidates = [];
  for (const part of value.split(',')) {
    const [tag, hex, extra] = part.trim().split('=');
    if (extra !== undefined || !hex || !HEX64.test(hex)) {
      throw new WebhookSignatureError(
        'Malformed X-Saas-Signature header: expected "v2=<64 hex characters>"',
        CODES.WEBHOOK_SIGNATURE_MALFORMED,
      );
    }
    if (tag === V2_TAG) candidates.push({ version: SIGNATURE_VERSIONS.TIMESTAMPED, hex: hex.toLowerCase() });
    else if (tag === EXPECTED_ALGO) candidates.push({ version: SIGNATURE_VERSIONS.LEGACY, hex: hex.toLowerCase() });
    else {
      throw new WebhookSignatureError(
        'Unsupported signature scheme: expected "v2=<hex>"',
        CODES.WEBHOOK_SIGNATURE_MALFORMED,
      );
    }
  }
  return candidates;
}

/**
 * Parse `X-Saas-Timestamp` (unix epoch SECONDS).
 *
 * @returns {number|null} epoch seconds, or null when absent and not required.
 * @throws {WebhookSignatureError} missing (when required) or malformed.
 */
export function parseTimestampHeader(value, { required = true } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    if (required) {
      throw new WebhookSignatureError('Missing X-Saas-Timestamp header (unix seconds)', CODES.WEBHOOK_TIMESTAMP_MISSING);
    }
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d{1,11}$/.test(trimmed)) {
    throw new WebhookSignatureError(
      'Malformed X-Saas-Timestamp header: expected unix epoch seconds',
      CODES.WEBHOOK_TIMESTAMP_INVALID,
    );
  }
  return Number(trimmed);
}

/**
 * Refuse a timestamp outside `[now - tolerance, now + MAX_FUTURE_SKEW]`.
 *
 * @throws {WebhookSignatureError}
 */
export function assertTimestampInWindow(epochSeconds, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, nowMs = Date.now()) {
  const ageSec = Math.floor(nowMs / 1000) - epochSeconds;
  if (ageSec > toleranceSeconds || ageSec < -MAX_FUTURE_SKEW_SECONDS) {
    throw new WebhookSignatureError(
      `X-Saas-Timestamp is outside the ${toleranceSeconds}s window; sign each delivery with the current time`,
      CODES.WEBHOOK_TIMESTAMP_OUT_OF_WINDOW,
    );
  }
}

/**
 * Secret-free checks run BEFORE the signing key is derived: header presence
 * and format, the scheme the connector accepts, and (for v2) the timestamp
 * window.
 *
 * @param {Object} opts
 * @param {Object} opts.headers - lower-cased header map.
 * @param {1|2} opts.connectorVersion - the connector's signature version.
 * @param {number} opts.toleranceSeconds - window for v2 timestamps.
 * @param {boolean} opts.legacyEnabled - whether v1 signatures are accepted at all.
 * @param {number} [opts.maxLegacyToleranceSeconds] - outer bound for a v1
 *   timestamp before the exact per-connector window is known.
 * @returns {{ version: 1|2, candidates: string[], timestamp: number|null }}
 * @throws {WebhookSignatureError}
 */
export function precheckWebhookHeaders({
  headers = {},
  connectorVersion = SIGNATURE_VERSIONS.LEGACY,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  legacyEnabled = true,
  maxLegacyToleranceSeconds = 3600,
  nowMs = Date.now(),
} = {}) {
  const parsed = parseSignatureHeader(headers[SIGNATURE_HEADER]);
  const v2 = parsed.filter((c) => c.version === SIGNATURE_VERSIONS.TIMESTAMPED).map((c) => c.hex);
  const v1 = parsed.filter((c) => c.version === SIGNATURE_VERSIONS.LEGACY).map((c) => c.hex);

  if (v2.length > 0) {
    const timestamp = parseTimestampHeader(headers[TIMESTAMP_HEADER], { required: true });
    assertTimestampInWindow(timestamp, toleranceSeconds, nowMs);
    return { version: SIGNATURE_VERSIONS.TIMESTAMPED, candidates: v2, timestamp };
  }
  if (connectorVersion >= SIGNATURE_VERSIONS.TIMESTAMPED || !legacyEnabled) {
    throw new WebhookSignatureError(
      'This webhook requires timestamp-bound signatures: send X-Saas-Timestamp and X-Saas-Signature: v2=HMAC_SHA256(secret, "<timestamp>.<body>")',
      CODES.WEBHOOK_LEGACY_SIGNATURE_REJECTED,
    );
  }
  const timestamp = parseTimestampHeader(headers[TIMESTAMP_HEADER], { required: false });
  if (timestamp !== null) assertTimestampInWindow(timestamp, maxLegacyToleranceSeconds, nowMs);
  return { version: SIGNATURE_VERSIONS.LEGACY, candidates: v1, timestamp };
}

/* -------------------------------- verify ---------------------------------- */

function safeHexEqual(expectedHex, givenHex) {
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(givenHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verify the pre-checked candidates against the signing secret.
 *
 * @param {Object} opts
 * @param {{ version: 1|2, candidates: string[], timestamp: number|null }} opts.precheck
 * @param {Buffer|string} opts.rawBody
 * @param {string} opts.secret
 * @returns {string} the matching signature (hex) - the replay id.
 * @throws {WebhookSignatureError} on mismatch.
 */
export function verifyPrechecked({ precheck, rawBody, secret }) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new WebhookSignatureError('Invalid webhook signature', CODES.WEBHOOK_SIGNATURE_INVALID);
  }
  const payload = precheck.version === SIGNATURE_VERSIONS.TIMESTAMPED
    ? signedPayload(precheck.timestamp, rawBody)
    : (Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8'));
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const match = precheck.candidates.find((hex) => safeHexEqual(expected, hex));
  if (!match) throw new WebhookSignatureError('Invalid webhook signature', CODES.WEBHOOK_SIGNATURE_INVALID);
  return match;
}

/* --------------------------- legacy helpers (v1) --------------------------- */

/**
 * LEGACY: verify a body-only `sha256=` signature in constant time.
 *
 * @param {Object} opts
 * @param {Buffer|string} opts.rawBody
 * @param {string} [opts.signatureHeader]
 * @param {string} opts.secret
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifySignature({ rawBody, signatureHeader, secret }) {
  if (typeof signatureHeader !== 'string' || signatureHeader.trim().length === 0) {
    return { valid: false, reason: 'missing signature header' };
  }
  const [algo, expected] = signatureHeader.trim().split('=');
  if (algo !== EXPECTED_ALGO || !expected) {
    return { valid: false, reason: 'unsupported signature algorithm' };
  }
  const actual = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { valid: false, reason: 'signature mismatch' };
  return { valid: crypto.timingSafeEqual(a, b), reason: 'signature mismatch' };
}

/**
 * LEGACY: verify the optional timestamp / replay window of a v1 request.
 *
 * @param {Object} opts
 * @param {string} [opts.timestampHeader] - epoch seconds.
 * @param {Object} [opts.rule] - { toleranceSeconds?, requireTimestamp? }.
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyTimestamp({ timestampHeader, rule = {} } = {}) {
  const {
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    requireTimestamp = false,
  } = rule;
  if (typeof timestampHeader !== 'string' || timestampHeader.trim().length === 0) {
    if (requireTimestamp) return { valid: false, reason: 'timestamp header required' };
    return { valid: true };
  }
  const epoch = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(epoch)) return { valid: false, reason: 'timestamp header malformed' };
  const ageSec = Math.floor(Date.now() / 1000) - epoch;
  if (ageSec < -MAX_FUTURE_SKEW_SECONDS || ageSec > toleranceSeconds) {
    return { valid: false, reason: `timestamp outside ${toleranceSeconds}s window` };
  }
  return { valid: true };
}

/**
 * LEGACY: verify a full v1 request and throw a fail-closed
 * `WebhookSignatureError` on any failure.
 *
 * @throws {WebhookSignatureError}
 */
export function verifyWebhook({ rawBody, headers, secret, rule }) {
  const sig = verifySignature({
    rawBody,
    signatureHeader: headers[SIGNATURE_HEADER],
    secret,
  });
  if (!sig.valid) throw new WebhookSignatureError(`Signature verification failed: ${sig.reason}`);

  const ts = verifyTimestamp({ timestampHeader: headers[TIMESTAMP_HEADER], rule });
  if (!ts.valid) throw new WebhookSignatureError(`Timestamp verification failed: ${ts.reason}`);
}

export default {
  computeSignature,
  computeTimestampedSignature,
  signedPayload,
  parseSignatureHeader,
  parseTimestampHeader,
  assertTimestampInWindow,
  precheckWebhookHeaders,
  verifyPrechecked,
  verifySignature,
  verifyTimestamp,
  verifyWebhook,
  DEFAULT_TOLERANCE_SECONDS,
  MAX_FUTURE_SKEW_SECONDS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  SIGNATURE_VERSIONS,
  CURRENT_SIGNATURE_VERSION,
};
