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
 *   - touchLastUsed, revoke, markRotated, revokeAllForActor,
 *     revokeAllForTenant, markExpired
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

/**
 * Atomically end an active session because it was rotated, recording its
 * successor. Exactly one concurrent caller can win: the others get null.
 */
export const markRotated = (sessionId, successorId) =>
  Session.findOneAndUpdate(
    { sessionId, status: 'active' },
    {
      $set: {
        status: 'revoked',
        revokedAt: new Date(),
        revokedReason: 'rotated',
        replacedBy: successorId,
      },
    },
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

/**
 * Revoke every active session scoped to a tenant. The tenant-suspend
 * cascade uses this so a suspended tenant cannot authenticate through any
 * lingering session. Explicit `tenantId` filtering (defence in depth on
 * top of the `tenantScope` plugin).
 */
export const revokeAllForTenant = async (tenantId, reason) => {
  const res = await Session.updateMany(
    { tenantId, status: 'active' },
    { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: reason ?? null } },
  );
  return res.modifiedCount;
};

/** Count active sessions in a tenant (used by tenant statistics). */
export const countActiveForTenant = (tenantId) =>
  Session.countDocuments({ tenantId, status: 'active' });

/** Mark an active session expired (e.g. the TTL has not purged it yet). */
export const markExpired = (sessionId) =>
  Session.findOneAndUpdate(
    { sessionId, status: 'active' },
    { $set: { status: 'expired' } },
    { new: true, lean: true },
  );

/**
 * adminauth: set (or clear with null) the restriction of a login: the given
 * session and every live session of its family, so a rotation racing the
 * change cannot keep the old state.
 */
export const setRestrictionForLogin = async (sessionId, restriction) => {
  const session = await Session.findOne({ sessionId }).lean();
  if (!session) return 0;
  const familyId = session.familyId ?? session.sessionId;
  const res = await Session.updateMany(
    { $or: [{ sessionId }, { familyId }], status: 'active' },
    { $set: { restriction: restriction ?? null } },
  );
  return res.modifiedCount;
};

/**
 * adminauth: set a restriction on EVERY live session of an actor (e.g. a
 * privileged admin turned MFA off: no device keeps full access).
 */
export const restrictAllForActor = async (actorId, restriction) => {
  const res = await Session.updateMany(
    { actorId: String(actorId), status: 'active' },
    { $set: { restriction } },
  );
  return res.modifiedCount;
};

/**
 * adminauth: revoke every live RESTRICTED session of an actor. Used after
 * MFA enrolment: other enrolment-only sessions were opened with a password
 * alone, so they end instead of inheriting the new second factor.
 */
export const revokeRestrictedForActor = async (actorId, reason) => {
  const res = await Session.updateMany(
    { actorId: String(actorId), status: 'active', restriction: { $ne: null } },
    { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: reason ?? null } },
  );
  return res.modifiedCount;
};

/** adminauth: record a successful step-up on a live session. */
export const markSteppedUp = (sessionId, at = new Date()) =>
  Session.findOneAndUpdate(
    { sessionId, status: 'active' },
    { $set: { stepUpAt: at } },
    { new: true, lean: true },
  );

export default {
  create,
  findById,
  findByRefreshTokenHash,
  findActiveByRefreshTokenHash,
  touchLastUsed,
  revoke,
  markRotated,
  revokeAllForActor,
  revokeAllForTenant,
  markExpired,
  countActiveForTenant,
  setRestrictionForLogin,
  restrictAllForActor,
  revokeRestrictedForActor,
  markSteppedUp,
  _meta: { leanReturns: true, tenancy: 'hybrid', refreshTokens: 'hashed-at-rest' },
};
