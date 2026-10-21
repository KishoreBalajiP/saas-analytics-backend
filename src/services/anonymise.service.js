// SHIM(compliance): replaced at integration
/**
 * Minimal `anonymiseUser` so the retention job can scrub a soft-deleted
 * user's personal data (finding db.06). The compliance package owns the
 * real implementation (every collection the subject appears in); this shim
 * only overwrites the identifying fields of the User row itself.
 */

import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { User } from '../models/User.js';

/**
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.userId
 * @param {string} [params.by]
 * @returns {Promise<{ User: number }>} rows anonymised per collection.
 */
export async function anonymiseUser({ tenantId, userId, by = 'system' } = {}) {
  if (!tenantId || !userId) throw new TypeError('anonymiseUser requires tenantId and userId');
  if (!mongoose.isValidObjectId(userId)) return { User: 0 };
  const token = createHash('sha256').update(String(userId)).digest('hex').slice(0, 24);
  // Raw driver update: no audit-plugin copy of the old values.
  const result = await User.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(userId)), tenantId: String(tenantId) },
    {
      $set: {
        email: `deleted-${token}@anonymised.invalid`,
        passwordHash: null,
        ssoProvider: null,
        ssoSubject: null,
        'profile.name': '',
        'profile.phone': null,
        'profile.avatarUrl': null,
      },
    },
  );
  return { User: result.modifiedCount ?? 0 };
}

export default { anonymiseUser };
