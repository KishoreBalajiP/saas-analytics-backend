import { EmailVerificationToken } from '../models/EmailVerificationToken.js';

export const create = async (data) => {
  const doc = await EmailVerificationToken.create(data);
  return doc.toObject();
};

export const findLiveByHash = (tokenHash) =>
  EmailVerificationToken.findOne({
    tokenHash,
    status: 'pending',
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();

/** Most recent live (pending, unused, unexpired) token for an account. */
export const findLatestPending = ({ tenantId, userId, email }) =>
  EmailVerificationToken.findOne({
    tenantId,
    userId,
    email,
    status: 'pending',
    usedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();

/** Persist the delivery outcome for a token (status, error, sent time). */
export const markDelivery = (id, { status, error = null, sentAt = null }) =>
  EmailVerificationToken.findByIdAndUpdate(
    id,
    { $set: { deliveryStatus: status, deliveryError: error, lastSentAt: sentAt } },
    { new: true, runValidators: true, lean: true },
  );

/** Remove every token for an account (registration rollback). */
export const deleteByUser = ({ tenantId, userId }) =>
  EmailVerificationToken.deleteMany({ tenantId, userId });

export const revokePending = ({ tenantId, userId, email }) =>
  EmailVerificationToken.updateMany(
    {
      tenantId,
      userId,
      email,
      status: 'pending',
      usedAt: null,
    },
    { $set: { status: 'expired', usedAt: new Date() } },
    { new: true },
  );

export const consume = async (id) =>
  EmailVerificationToken.findOneAndUpdate(
    {
      _id: id,
      status: 'pending',
      usedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { status: 'used', usedAt: new Date() } },
    { new: true, runValidators: true, lean: true },
  );

export default {
  create,
  findLiveByHash,
  findLatestPending,
  markDelivery,
  deleteByUser,
  revokePending,
  consume,
  _meta: { singleUseToken: true },
};
