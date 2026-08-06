/**
 * Session Repository (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Data-access surface for the session lifecycle backed by
 *   `models/Session.js`. Sessions are the single source of truth for
 *   "is this identity allowed right now" (revocation before JWT expiry).
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - create, findById, findByRefreshTokenHash, findActiveByRefreshTokenHash
 *   - touchLastUsed, revoke, revokeAllForActor, markExpired
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - The refresh-token lookup is GLOBAL by design: platform-admin and
 *     tenant-user sessions share one collection and the token is unique.
 *   - Revocation is a single atomic `findOneAndUpdate`; rotation sequencing
 *     (create new + revoke old) is the service's job.
 *   - `revoke` only transitions `active` sessions, so a reused/replayed
 *     token is never silently re-revoked - the service decides the policy
 *     (family revocation) from the returned document.
 */

import { Session } from '../models/Session.js';

/** Create a session document. Returns a plain object. */
export const create = async (data) => {
  const doc = await Session.create(data);
  return doc.toObject();
};

/** Find a session by its public sessionId. */
export const findById = (sessionId) => Session.findOne({ sessionId }).lean();

/** Find a session by the hashed refresh token (any status). */
export const findByRefreshTokenHash = (refreshTokenHash) =>
  Session.findOne({ refreshTokenHash }).lean();

/** Find a session by the hashed refresh token, active only. */
export const findActiveByRefreshTokenHash = (refreshTokenHash) =>
  Session.findOne({ refreshTokenHash, status: 'active' }).lean();

/** Refresh a session's last-used timestamp. */
export const touchLastUsed = (sessionId) =>
  Session.findOneAndUpdate(
    { sessionId },
    { $set: { lastUsedAt: new Date() } },
    { new: true, lean: true },
  );

/** Revoke an active session. Returns the updated session or null. */
export const revoke = (sessionId, reason) =>
  Session.findOneAndUpdate(
    { sessionId, status: 'active' },
    { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: reason ?? null } },
    { new: true, lean: true },
  );

/** Revoke every active session for an actor. Returns the modified count. */
export const revokeAllForActor = async (actorId, reason) => {
  const res = await Session.updateMany(
    { actorId, status: 'active' },
    { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: reason ?? null } },
  );
  return res.modifiedCount;
};

/** Mark an active session expired (e.g. the TTL has not purged it yet). */
export const markExpired = (sessionId) =>
  Session.findOneAndUpdate(
    { sessionId, status: 'active' },
    { $set: { status: 'expired' } },
    { new: true, lean: true },
  );

export default {
  create,
  findById,
  findByRefreshTokenHash,
  findActiveByRefreshTokenHash,
  touchLastUsed,
  revoke,
  revokeAllForActor,
  markExpired,
  _meta: { leanReturns: true, tenancy: 'hybrid', refreshTokens: 'hashed-at-rest' },
};
