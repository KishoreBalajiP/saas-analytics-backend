import { PasswordResetToken } from '../models/PasswordResetToken.js';

export const create = async (data) => {
  const doc = await PasswordResetToken.create(data);
  return doc.toObject();
};

/** Atomically consume a live token; null means invalid, expired, or reused. */
export const consume = ({ portal, tokenHash, actorId, tenantId = null }) =>
  PasswordResetToken.findOneAndUpdate(
    {
      portal,
      tokenHash,
      actorId,
      tenantId,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
    { new: true, lean: true },
  ).select('+tokenHash');

export default { create, consume };
