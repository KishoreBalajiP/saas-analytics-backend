/**
 * Tenant invitation repository.
 *
 * LIFECYCLE (roadmap 2.10, ten.12)
 *   `pending` -> `accepted` | `revoked` | `expired`. Rows are kept as
 *   history; `markExpired` moves a pending row past its `expiresAt` to
 *   `expired` (the expiry sweep), and `rotateToken` re-issues the link of a
 *   pending invitation in place (resend) so the seat it holds never churns.
 *
 * CODING GUIDELINES
 *   - Database access only; seats, grants and audit live in the service.
 *   - State changes are single conditional updates on `status: 'pending'`.
 */

import { TenantInvitation } from '../models/TenantInvitation.js';

export const create = async (data) => (await TenantInvitation.create(data)).toObject();

export const findLiveByHash = (tokenHash) => TenantInvitation.findOne({
  tokenHash,
  status: 'pending',
  expiresAt: { $gt: new Date() },
}).select('+tokenHash').lean();

export const consume = ({ id, acceptedBy }) => TenantInvitation.findOneAndUpdate(
  { _id: id, status: 'pending', expiresAt: { $gt: new Date() } },
  { $set: { status: 'accepted', acceptedAt: new Date(), acceptedBy } },
  { new: true, lean: true },
).select('+tokenHash');

export const revokePending = async ({ tenantId, invitedEmail, by }) => {
  const result = await TenantInvitation.updateMany(
    { tenantId, invitedEmail: invitedEmail.toLowerCase(), status: 'pending' },
    { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: by ? String(by) : null } },
  );
  return result.modifiedCount ?? result.nModified ?? 0;
};

export const revoke = (id, by) => TenantInvitation.findOneAndUpdate(
  { _id: id, status: 'pending' },
  { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: by ? String(by) : null } },
  { new: true, lean: true },
);

/**
 * Re-issue the link of a pending invitation (resend): new token digest, new
 * expiry, `resendCount + 1`. The previous link stops working. Returns the
 * updated row, or null when it is no longer pending.
 */
export const rotateToken = ({ id, tenantId, tokenHash, expiresAt, now = new Date() }) => TenantInvitation.findOneAndUpdate(
  { _id: id, tenantId: String(tenantId), status: 'pending' },
  { $set: { tokenHash, expiresAt, lastSentAt: now }, $inc: { resendCount: 1 } },
  { new: true, lean: true },
);

/** Pending invitations whose link has lapsed (expiry sweep input). */
export const listDueForExpiry = ({ now = new Date(), limit = 500 } = {}) => TenantInvitation.find({
  status: 'pending',
  expiresAt: { $lte: now },
})
  .sort({ expiresAt: 1 })
  .limit(limit)
  .select('_id tenantId invitedEmail roleName expiresAt')
  .lean();

/**
 * Move one lapsed pending invitation to `expired`. Returns the updated row,
 * or null when it was accepted, revoked or resent meanwhile.
 */
export const markExpired = ({ id, now = new Date() }) => TenantInvitation.findOneAndUpdate(
  { _id: id, status: 'pending', expiresAt: { $lte: now } },
  { $set: { status: 'expired', expiredAt: now } },
  { new: true, lean: true },
);

export const findById = (id) => TenantInvitation.findById(id).lean();

export const findPendingByEmail = ({ tenantId, invitedEmail }) => TenantInvitation.findOne({
  tenantId,
  invitedEmail: invitedEmail.toLowerCase(),
  status: 'pending',
}).lean();

export const list = async ({ tenantId, status, page = 1, limit = 20 } = {}) => {
  if (!tenantId) throw new Error('tenantInvitation.repository: tenantId is required');
  const filter = { tenantId: String(tenantId) };
  if (status) filter.status = status;
  const result = await TenantInvitation.paginate(filter, {
    page, limit, lean: true, sort: { createdAt: -1 },
  });
  return { docs: result.docs, total: result.totalDocs, page: result.page, limit: result.limit, pages: result.totalPages };
};

export default {
  create,
  findLiveByHash,
  consume,
  revokePending,
  revoke,
  rotateToken,
  listDueForExpiry,
  markExpired,
  findById,
  findPendingByEmail,
  list,
};
