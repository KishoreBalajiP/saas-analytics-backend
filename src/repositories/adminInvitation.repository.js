/**
 * AdminInvitation Repository (roadmap 2.2, adminauth).
 *
 * PURPOSE
 *   Data access for platform-admin invitations. Admin invitations are
 *   platform-scoped (no tenantId). Only token DIGESTS are ever written or
 *   matched; `tokenHash` is never returned (`select: false`).
 *
 * RESPONSIBILITY
 *   - create, findPendingForAdmin, findLiveByTokenHash
 *   - claimByTokenHash (atomic single use), rotateToken (resend),
 *     markRevoked, markDelivered, list
 *
 * CODING GUIDELINES
 *   - Reads return plain objects (`lean`).
 *   - State transitions are conditional updates on `status: 'pending'`, so
 *     two concurrent accepts (or an accept racing a revoke) resolve to one
 *     winner.
 */

import { AdminInvitation } from '../models/AdminInvitation.js';

/** Create a pending invitation row. `data.tokenHash` must be a digest. */
export const create = async (data) => {
  const doc = new AdminInvitation(data);
  await doc.save();
  const { tokenHash: _omit, ...plain } = doc.toObject();
  return plain;
};

/** The pending invitation of an admin (at most one exists), or null. */
export const findPendingForAdmin = (adminId) =>
  AdminInvitation.findOne({ adminId: String(adminId), status: 'pending' }).lean();

/** A pending, unexpired invitation by token digest, or null. */
export const findLiveByTokenHash = (tokenHash, now = new Date()) =>
  AdminInvitation.findOne({ tokenHash, status: 'pending', expiresAt: { $gt: now } }).lean();

/**
 * Atomically consume a live invitation (status -> accepted). Returns the
 * accepted row, or null when the token is unknown, expired, revoked or was
 * already used.
 */
export const claimByTokenHash = (tokenHash, now = new Date()) =>
  AdminInvitation.findOneAndUpdate(
    { tokenHash, status: 'pending', expiresAt: { $gt: now } },
    { $set: { status: 'accepted', acceptedAt: now } },
    { new: true, lean: true },
  );

/**
 * Supersede the token of a pending invitation (resend): new digest, new
 * expiry, one more send. Returns the updated row or null.
 */
export const rotateToken = (id, { tokenHash, expiresAt, now = new Date() }) =>
  AdminInvitation.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { tokenHash, expiresAt, lastSentAt: now, delivered: false }, $inc: { sendCount: 1 } },
    { new: true, lean: true },
  );

/** Revoke a pending invitation. Returns the updated row or null. */
export const markRevoked = (id, { by = null, reason = null, now = new Date() } = {}) =>
  AdminInvitation.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status: 'revoked', revokedAt: now, revokedBy: by, revokedReason: reason } },
    { new: true, lean: true },
  );

/** Record whether the last send reached the mail transport. */
export const markDelivered = (id, delivered) =>
  AdminInvitation.updateOne({ _id: id }, { $set: { delivered: Boolean(delivered) } });

/** Paginated invitation history, newest first. */
export const list = async ({ filter = {}, page = 1, limit = 20 } = {}) => {
  const result = await AdminInvitation.paginate(filter, {
    page,
    limit,
    lean: true,
    sort: { createdAt: -1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

export default {
  create,
  findPendingForAdmin,
  findLiveByTokenHash,
  claimByTokenHash,
  rotateToken,
  markRevoked,
  markDelivered,
  list,
  _meta: { leanReturns: true, tenancy: 'platform', tokens: 'sha256-digests-only' },
};
