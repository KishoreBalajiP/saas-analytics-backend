/**
 * JWT utilities (signing + verification) for the SaaS Analytics Platform.
 *
 * WHY IT EXISTS
 *   Centralises every JWT operation (access tokens, refresh tokens, internal
 *   service tokens, MFA challenge tokens). Using `jose` keeps the
 *   implementation modern: JSON Web Signature, JSON Web Encryption ready,
 *   algorithm agility and key rotation out of the box.
 *
 * RESPONSIBILITY
 *   - Sign tokens with a configurable algorithm, issuer, audience and TTL.
 *   - Verify tokens and return the decoded payload (or throw a typed error).
 *   - Decode without verification (useful for logging only).
 *   - Provide typed errors so callers can distinguish expired vs malformed.
 *
 * DESIGN CONSTRAINTS
 *   - Never reads `process.env` directly. Configuration is passed in.
 *   - Never logs the raw token.
 *   - Defaults to HS256 with the `config.security.jwtSecret`. When production
 *     introduces a public/private key pair (RS256/ES256) only the call site
 *     changes; this module stays stable.
 *
 * HOW TO EXTEND
 *   - Add a new helper (e.g. `mfaChallengeToken`) by composing `sign()` +
 *     `verify()` with a distinct audience. Do not duplicate signing logic.
 */

import { SignJWT, jwtVerify } from 'jose';
import env from '../config/env.js';

const DEFAULT_ALG = 'HS256';
const DEFAULT_TYPE = 'JWT';

/** Canonical JWT audiences recognised by the platform. */
export const JWT_AUDIENCES = Object.freeze({
  USER: 'user',
  ADMIN: 'admin',
  EMBED: 'embed',
  SERVICE: 'service',
});

/** Canonical JWT issuers. */
export const JWT_ISSUERS = Object.freeze({
  PLATFORM: 'saas-analytics',
});

/* ----------------------------- helpers ---------------------------------- */

/**
 * Encode the configured JWT secret into a `Uint8Array` key consumable by
 * `jose`. The same secret is used for every audience until production
 * introduces per-audience keys (Phase 4+).
 *
 * @returns {Uint8Array} binary secret.
 */
function getSecretKey() {
  return new TextEncoder().encode(env.security.jwtSecret);
}

/**
 * Normalise TTL strings (`15m`, `1h`, `7d`) into seconds.
 * Defaults to the configured `JWT_EXPIRES_IN` when no value is supplied.
 *
 * @param {string|number} [value] - TTL string or seconds.
 * @returns {number} TTL in seconds (always positive integer).
 */
export function parseExpiresIn(value) {
  const raw = value ?? env.security.jwtExpiresIn;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new Error('JWT TTL must be a positive number of seconds');
    }
    return Math.floor(raw);
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('JWT TTL must be a non-empty string or number');
  }
  const match = /^(\d+)\s*([smhdw])$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`Invalid JWT TTL format "${raw}". Use e.g. "15m", "1h", "7d".`);
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = { s: 1, m: 60, h: 60 * 60, d: 60 * 60 * 24, w: 60 * 60 * 24 * 7 }[unit];
  return amount * multiplier;
}

/* -------------------------------- errors -------------------------------- */

/**
 * Custom error class for JWT failures. Carries a stable `code` so the global
 * error middleware can map it to a precise HTTP status / machine code.
 */
export class JwtError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JwtError';
    this.code = code;
    this.isOperational = true;
  }
}

/* ------------------------------- signers -------------------------------- */

/**
 * Sign a JWT with the given payload. The function is async because `jose`
 * exposes a Promise-based API.
 *
 * @param {Object} params
 * @param {Object} params.payload - claims to encode (e.g. { sub, tenantId }).
 * @param {string} [params.audience='user'] - one of `JWT_AUDIENCES`.
 * @param {string} [params.issuer='saas-analytics'] - one of `JWT_ISSUERS`.
 * @param {string|number} [params.expiresIn] - TTL string (e.g. `15m`) or seconds.
 * @param {string} [params.subject] - subject claim; defaults to `payload.sub`.
 * @param {string} [params.jwtId] - explicit `jti`; auto-generated otherwise.
 * @param {string} [params.algorithm] - signature algorithm (defaults HS256).
 * @returns {Promise<string>} signed JWT compact form.
 */
export async function sign({
  payload,
  audience = JWT_AUDIENCES.USER,
  issuer = JWT_ISSUERS.PLATFORM,
  expiresIn,
  subject,
  jwtId,
  algorithm = DEFAULT_ALG,
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('JWT payload must be a plain object');
  }
  const ttlSeconds = parseExpiresIn(expiresIn);
  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: algorithm, typ: DEFAULT_TYPE })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(`${ttlSeconds}s`)
    .setJti(jwtId ?? cryptoRandomId());

  if (subject ?? payload.sub) {
    builder.setSubject(String(subject ?? payload.sub));
  }

  return builder.sign(getSecretKey());
}

/* ------------------------------- verifiers ------------------------------ */

/**
 * Verify a JWT and return its payload. Throws `JwtError` on any failure with
 * a stable code (`EXPIRED`, `INVALID`, `WRONG_AUDIENCE`, `WRONG_ISSUER`).
 *
 * @param {Object} params
 * @param {string} params.token - compact JWT.
 * @param {string|string[]} [params.audience] - required audience(s).
 * @param {string} [params.issuer] - required issuer.
 * @param {string[]} [params.algorithms] - accepted algorithms (default [HS256]).
 * @param {number} [params.clockToleranceSec=0] - leeway for clock skew.
 * @returns {Promise<{ payload: Object, protectedHeader: Object }>}
 */
export async function verify({
  token,
  audience,
  issuer = JWT_ISSUERS.PLATFORM,
  algorithms = [DEFAULT_ALG],
  clockToleranceSec = 0,
} = {}) {
  if (!token || typeof token !== 'string') {
    throw new JwtError('INVALID', 'JWT token is required');
  }

  try {
    const result = await jwtVerify(token, getSecretKey(), {
      issuer,
      audience,
      algorithms,
      clockTolerance: clockToleranceSec,
    });
    return { payload: result.payload, protectedHeader: result.protectedHeader };
  } catch (err) {
    const code = mapJoseError(err);
    throw new JwtError(code, err.message || `JWT verification failed (${code})`);
  }
}

/**
 * Decode a JWT without verifying its signature. Useful for logging /
 * debugging only - DO NOT trust the result for authorization decisions.
 *
 * @param {string} token - compact JWT.
 * @returns {Object|null} decoded payload or `null` if the token is malformed.
 */
export function decode(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/* ------------------------------ internals ------------------------------- */

/**
 * Map a `jose` error to one of our stable codes.
 *
 * @param {Error} err - error thrown by `jose`.
 * @returns {string} one of `JwtError` codes.
 */
function mapJoseError(err) {
  const code = err?.code ?? '';
  if (code === 'ERR_JWT_EXPIRED') return 'EXPIRED';
  if (code === 'ERR_JWS_INVALID' || code === 'ERR_JWT_INVALID') return 'INVALID';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') return 'INVALID';
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return 'INVALID_SIGNATURE';
  return 'INVALID';
}

/**
 * Generate a cryptographically random ID using Node's webcrypto. Used as a
 * default `jti` when the caller does not provide one.
 *
 * @returns {string} 16-byte hex token.
 */
function cryptoRandomId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  sign,
  verify,
  decode,
  parseExpiresIn,
  JwtError,
  JWT_AUDIENCES,
  JWT_ISSUERS,
};
