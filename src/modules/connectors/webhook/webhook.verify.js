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
 * HEADER CONTRACT
 *   - `X-Saas-Signature: sha256=<hex>` - HMAC-SHA256 over the RAW request
 *     body bytes, keyed with the connector's decrypted `signingSecret`.
 *   - `X-Saas-Timestamp: <epoch seconds>` (optional) - replay protection.
 *     Requests older than `toleranceSeconds` are rejected. When the
 *     connector config sets `requireTimestamp: true`, a missing header is
 *     also rejected.
 *
 * FAIL CLOSED
 *   Missing/malformed signature, unknown algorithm, expired timestamp and
 *   mismatch all fail. There is no pass-through path.
 *
 * @module webhook-verify
 */

import crypto from 'node:crypto';
import { WebhookSignatureError } from '../shared/errors.js';

export const DEFAULT_TOLERANCE_SECONDS = 300;
export const SIGNATURE_HEADER = 'x-saas-signature';
export const TIMESTAMP_HEADER = 'x-saas-timestamp';
const EXPECTED_ALGO = 'sha256';

/**
 * Compute the canonical `X-Saas-Signature` value for a raw body. Useful for
 * clients and tests that must craft a valid signature.
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

/**
 * Verify a signature header against the raw body in constant time.
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
 * Verify the optional timestamp / replay window.
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
  if (ageSec < -60 || ageSec > toleranceSeconds) {
    return { valid: false, reason: `timestamp outside ${toleranceSeconds}s window` };
  }
  return { valid: true };
}

/**
 * Verify the full webhook request and throw a fail-closed
 * `WebhookSignatureError` on any failure. Controllers call this after
 * looking up the connector's decrypted config.
 *
 * @param {Object} opts
 * @param {Buffer|string} opts.rawBody
 * @param {Object} opts.headers - lower-cased header map from Express.
 * @param {string} opts.secret
 * @param {Object} [opts.rule]
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
  verifySignature,
  verifyTimestamp,
  verifyWebhook,
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
};
