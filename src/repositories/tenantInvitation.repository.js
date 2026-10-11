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
    { $set: { status: 'revoked', revokedAt: new Date(), updatedBy: by } },
  );
  return result.modifiedCount ?? result.nModified ?? 0;
};

export const revoke = (id, by) => TenantInvitation.findOneAndUpdate(
  { _id: id, status: 'pending' },
  { $set: { status: 'revoked', revokedAt: new Date(), updatedBy: by } },
  { new: true, lean: true },
);

export const findById = (id) => TenantInvitation.findById(id).lean();

export const findPendingByEmail = ({ tenantId, invitedEmail }) => TenantInvitation.findOne({
  tenantId,
  invitedEmail: invitedEmail.toLowerCase(),
  status: 'pending',
}).lean();

export const list = async ({ tenantId, status, page = 1, limit = 20 } = {}) => {
  const filter = { tenantId };
  if (status) filter.status = status;
  const result = await TenantInvitation.paginate(filter, {
    page, limit, lean: true, sort: { createdAt: -1 },
  });
  return { docs: result.docs, total: result.totalDocs, page: result.page, limit: result.limit, pages: result.totalPages };
};

export default { create, findLiveByHash, consume, revokePending, revoke, findById, findPendingByEmail, list };
