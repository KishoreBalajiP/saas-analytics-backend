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
  revokePending,
  consume,
  _meta: { singleUseToken: true },
};
