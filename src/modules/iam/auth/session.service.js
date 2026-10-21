/**
 * Session Service (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Orchestrates the session lifecycle on top of
 *   `repositories/session.repository.js`: create, rotate, revoke, revoke-all
 *   and expiry. Sessions are the single source of truth for "is this identity
 *   allowed right now" - JWT access tokens are short-lived and cannot be
 *   revoked early.
 *
 * RESPONSIBILITY (business rules ONLY - no raw database access)
 *   - create({ actorId, actorType, tenantId, refreshToken, ...meta })
 *     -> persists a session, returns `{ session, refreshToken }`.
 *   - rotate({ session, refreshToken, ...meta }) -> create the successor,
 *     then revoke the predecessor (rotation sequencing lives HERE).
 *   - revoke({ sessionId, reason }) / revokeAllForActor({ actorId, reason }).
 *     Each revocation that ends a live session is recorded as an
 *     `auth.session.revoked` security event (who, whose, why, how many).
 *
 * SECURITY RULES
 *   - Refresh tokens are opaque 256-bit values (URL-safe base64). They are
 *     returned to the caller exactly ONCE and persisted ONLY as a KDF hash
 *     (`utils/password.js`) - the raw token never touches the database.
 *   - Refresh-token hashes are DETERMINISTIC: the salt is the SHA-256
 *     fingerprint of the token itself, so the presented token always maps to
 *     the same stored hash and `sessionRepository.findByRefreshTokenHash` can
 *     match it. Security is unaffected - the token is a fresh 256-bit secret,
 *     so a leaked hash still costs a full KDF evaluation per guess.
 *   - Rotation ordering matters: the successor is created FIRST and the
 *     predecessor revoked second, so a failed write never logs a user out.
 *   - The session TTL is read from `security.auth.refreshTokenTtl`
 *     (ISO-duration string) and translated to a server-side `expiresAt`
 *     Date here - the repository only persists what it is told.
 *   - Absolute lifetime: every session records the family's original
 *     sign-in (`authenticatedAt`). Rotation copies it forward and caps the
 *     successor's `expiresAt` at `authenticatedAt + sessionAbsoluteTtl`, so
 *     refreshing can never keep one login alive past that ceiling.
 */

import { createHash, randomBytes } from 'node:crypto';
import env from '../../../config/env.js';
import { createChildLogger } from '../../../utils/logger.js';
import { hash } from '../../../utils/password.js';
import { parseExpiresIn } from '../../../utils/jwt.js';
import { withPrefix, PREFIXES } from '../../../utils/id.js';
import sessionRepository from '../../../repositories/session.repository.js';
import { securityEvent } from '../../../services/securityEvent.service.js';
import { getCurrentActor } from '../../../utils/actorContext.js';
// support: typed refusal when a support session is presented for refresh.
import ApiError from '../../../utils/ApiError.js';
import { ERROR_CODES } from '../../../config/constants.js';

const logger = createChildLogger({ module: 'services/session' });
const AUTH = env.security.auth;

/* ------------------------------ tokens ---------------------------------- */

/**
 * Generate an opaque 256-bit refresh token (URL-safe, no padding).
 * The caller hands it to the client ONCE and passes it straight to
 * `create`/`rotate` so only the Argon2id hash is persisted.
 *
 * @returns {string} 43-character base64url token.
 */
export function generateRefreshToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a refresh token for storage. This is the ONLY value that every
 * repository write path ever sees. The hash is deterministic - the salt is
 * derived from the token itself - so the refresh / logout-by-refresh paths
 * can look the session up by hashing the presented token again.
 *
 * @param {string} token - raw opaque refresh token.
 * @returns {Promise<string>} PHC-encoded hash.
 */
export function hashRefreshToken(token) {
  // SHA-256 of the token as salt: 32 bytes, within the 8-64 byte salt range
  // accepted by `utils/password.js` for both Argon2id and scrypt.
  const salt = createHash('sha256').update(token).digest();
  return hash(token, salt);
}

/**
 * Translate `security.auth.refreshTokenTtl` (e.g. `30d`) into a session
 * `expiresAt` Date. Centralised here so callers never re-implement the
 * duration parsing.
 *
 * @returns {Date}
 */
export function sessionExpiryFromNow() {
  return new Date(Date.now() + parseExpiresIn(AUTH.refreshTokenTtl) * 1000);
}

/**
 * The original sign-in time of a session family. Sessions written before
 * `authenticatedAt` existed fall back to their own issue time.
 *
 * @param {Object} session
 * @returns {Date}
 */
export function familyAuthenticatedAt(session) {
  const raw = session?.authenticatedAt ?? session?.issuedAt ?? session?.createdAt ?? null;
  const date = raw ? new Date(raw) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/**
 * The hard deadline of a session family: `authenticatedAt` plus the
 * configured absolute lifetime (`AUTH_SESSION_ABSOLUTE_TTL`).
 *
 * @param {Date|string} authenticatedAt
 * @returns {Date}
 */
export function absoluteExpiryFor(authenticatedAt) {
  return new Date(new Date(authenticatedAt).getTime() + parseExpiresIn(AUTH.sessionAbsoluteTtl) * 1000);
}

/**
 * True when the session family has outlived its absolute lifetime.
 *
 * @param {Object} session
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isPastAbsoluteLifetime(session, now = Date.now()) {
  return absoluteExpiryFor(familyAuthenticatedAt(session)).getTime() <= now;
}

/**
 * `expiresAt` for a new session of a family: the sliding refresh TTL,
 * never later than the family's absolute deadline.
 *
 * @param {Date} authenticatedAt
 * @returns {Date}
 */
function cappedExpiry(authenticatedAt) {
  const sliding = sessionExpiryFromNow().getTime();
  const absolute = absoluteExpiryFor(authenticatedAt).getTime();
  return new Date(Math.min(sliding, absolute));
}

/* ------------------------------ lifecycle ------------------------------- */

/**
 * Create a new active session. Persists the Argon2id hash of the refresh
 * token; returns the raw token (to deliver once) together with the session.
 *
 * @param {Object} params
 * @param {string} params.actorId - subject id (`usr_..` / `adm_..`).
 * @param {'user'|'admin'} params.actorType - session owner type.
 * @param {string|null} [params.tenantId] - tenant scope for user sessions.
 * @param {string} params.refreshToken - raw opaque token (hashed at rest).
 * @param {Object} [params.device] - device binding meta.
 * @param {string} [params.ip] - login IP.
 * @param {string} [params.userAgent] - login user agent.
 * @param {string} [params.impersonatedBy] - support admin id when this
 *   session is an impersonation (Sprint 8).
 * @param {Date} [params.authenticatedAt] - original sign-in time of the
 *   family (defaults to now, i.e. a fresh login).
 * @param {string} [params.familyId] - family id to join (defaults to the
 *   new session's own id, i.e. a fresh login).
 * @param {string|null} [params.restriction] - adminauth: restricted session
 *   (`mfa_enrollment`), null for a normal one.
 * @param {Date|null} [params.stepUpAt] - adminauth: last step-up carried
 *   over by rotation.
 * @returns {Promise<{ session: Object, refreshToken: string }>}
 */
export async function create({
  actorId,
  actorType,
  tenantId = null,
  refreshToken,
  device = {},
  ip = '',
  userAgent = '',
  impersonatedBy = null,
  authenticatedAt = null,
  familyId = null,
  expiresAt = null,
  restriction = null,
  stepUpAt = null,
}) {
  if (!actorId || !actorType || typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new Error('session.create requires actorId, actorType and a refresh token');
  }
  const refreshTokenHash = await hashRefreshToken(refreshToken);
  const sessionId = withPrefix(PREFIXES.SESSION);
  const signedInAt = authenticatedAt ? new Date(authenticatedAt) : new Date();
  const session = await sessionRepository.create({
    sessionId,
    familyId: familyId ?? sessionId,
    authenticatedAt: signedInAt,
    actorId,
    actorType,
    tenantId: tenantId ?? null,
    impersonatedBy: impersonatedBy ?? null,
    refreshTokenHash,
    device: normalizeDevice(device),
    ip,
    userAgent,
    issuedAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: expiresAt
      ? new Date(Math.min(new Date(expiresAt).getTime(), cappedExpiry(signedInAt).getTime()))
      : cappedExpiry(signedInAt),
    status: 'active',
    revokedAt: null,
    revokedReason: null,
    restriction: restriction ?? null,
    stepUpAt: stepUpAt ?? null,
  });
  logger.debug({ sessionId: session.sessionId, actorType }, 'session created');
  return { session, refreshToken };
}

/**
 * Rotate a session: persist the successor first, then end the predecessor
 * with an atomic compare-and-set (`active` -> `revoked/rotated`, recording
 * `replacedBy`). Used by every refresh exchange - the old token can no
 * longer be used after this returns.
 *
 * Two concurrent refreshes presenting the same token (two tabs, a retry)
 * both read the predecessor as active, but only one can claim it. The
 * loser discards the successor it created and gets `null`, so a login never
 * forks into two live sessions; the caller resolves the winner's successor
 * through `replacedBy`.
 *
 * @param {Object} params
 * @param {Object} params.session - the (active) session being replaced.
 * @param {string} params.refreshToken - fresh raw token for the successor.
 * @param {Object} [params.device] - optional new device binding; falls back
 *   to the predecessor's so rotation keeps the original context.
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 * @param {string|null} [params.restriction] - adminauth: restriction for
 *   the successor; omitted keeps the predecessor's.
 * @returns {Promise<{ session: Object, refreshToken: string }|null>} `null`
 *   when another request rotated the session first.
 */
export async function rotate({ session, refreshToken, device, ip, userAgent, restriction }) {
  // support: a support (impersonation) session is time-boxed and ends with
  // its token; it is never refreshed into a longer-lived one.
  if (session?.impersonatedBy) {
    throw new ApiError(401, 'Support sessions cannot be refreshed', { code: ERROR_CODES.SESSION_EXPIRED });
  }
  const next = await create({
    actorId: session.actorId,
    actorType: session.actorType,
    tenantId: session.tenantId ?? null,
    impersonatedBy: session.impersonatedBy ?? null,
    // The successor stays in the same family and keeps the original sign-in
    // time, so the absolute lifetime is never extended by rotation.
    authenticatedAt: familyAuthenticatedAt(session),
    familyId: session.familyId ?? session.sessionId,
    // adminauth: a restricted login stays restricted (the caller may
    // tighten it: `restriction`), and a recent step-up keeps its (short)
    // window across rotation.
    restriction: restriction === undefined ? session.restriction ?? null : restriction,
    stepUpAt: session.stepUpAt ?? null,
    refreshToken,
    device: device ?? session.device,
    ip: ip ?? session.ip,
    userAgent: userAgent ?? session.userAgent,
  });
  const claimed = await sessionRepository.markRotated(session.sessionId, next.session.sessionId);
  if (!claimed) {
    // Another request ended the predecessor first. Our successor's token is
    // never handed out; end it so the login does not fork.
    await sessionRepository.revoke(next.session.sessionId, 'rotation_superseded');
    logger.debug({ sessionId: session.sessionId }, 'session rotation lost a concurrent race');
    return null;
  }
  logger.debug({ sessionId: session.sessionId }, 'session rotated');
  return next;
}

/**
 * Revoke a single session. Idempotent: already-revoked sessions return
 * `false` and the caller treats it as success.
 *
 * @param {Object} params
 * @param {string} params.sessionId
 * @param {string} [params.reason='logout']
 * @returns {Promise<boolean>} `true` when the session was transitioned.
 */
export async function revoke({ sessionId, reason = 'logout' }) {
  const updated = await sessionRepository.revoke(sessionId, reason);
  if (updated) {
    const owner = { type: updated.actorType === 'admin' ? 'admin' : 'user', id: String(updated.actorId) };
    await securityEvent('SESSION_REVOKED', {
      actor: getCurrentActor() ?? owner,
      tenantId: updated.tenantId ?? null,
      resource: { type: 'session', id: sessionId },
      reason,
      metadata: { reason, scope: 'one', count: 1, subjectType: owner.type, subjectId: owner.id },
    });
  }
  return Boolean(updated);
}

/**
 * Revoke every active session for an actor. Used on logout-all, password
 * reset and refresh-token replay (family revocation).
 *
 * @param {Object} params
 * @param {string} params.actorId
 * @param {string} [params.reason]
 * @returns {Promise<number>} number of sessions revoked.
 */
export async function revokeAllForActor({ actorId, reason = 'logout_all', tenantId } = {}) {
  const count = await sessionRepository.revokeAllForActor(actorId, reason);
  if (count > 0) {
    await securityEvent('SESSION_REVOKED', {
      ...(tenantId !== undefined ? { tenantId } : {}),
      resource: { type: 'actor', id: String(actorId) },
      reason,
      metadata: { reason, scope: 'all', count, subjectId: String(actorId) },
    });
  }
  return count;
}

/**
 * Transition an active session to `expired` (normally the TTL index purges
 * it later; this keeps the audit trail honest for hard-expiry checks).
 *
 * @param {string} sessionId
 * @returns {Promise<Object|null>} updated session or null.
 */
export function markExpired(sessionId) {
  return sessionRepository.markExpired(sessionId);
}

/* ------------------------------ internals ------------------------------- */

/**
 * Normalise the free-form `device` meta into the shape the Session schema
 * expects, so callers never have to know the schema.
 *
 * @param {Object} device
 * @returns {{ id: string|null, name: string, os: string, browser: string, fingerprint: string|null }}
 */
function normalizeDevice(device = {}) {
  return {
    id: device.id ?? null,
    name: device.name ?? '',
    os: device.os ?? '',
    browser: device.browser ?? '',
    fingerprint: device.fingerprint ?? null,
  };
}

export default {
  generateRefreshToken,
  hashRefreshToken,
  sessionExpiryFromNow,
  familyAuthenticatedAt,
  absoluteExpiryFor,
  isPastAbsoluteLifetime,
  create,
  rotate,
  revoke,
  revokeAllForActor,
  markExpired,
  _meta: { refreshTokens: 'hashed-at-rest', rotation: 'create-then-revoke' },
};
