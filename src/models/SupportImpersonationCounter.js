/**
 * SupportImpersonationCounter (roadmap 2.3 - atomic impersonation cap).
 *
 * PURPOSE
 *   One document per (admin, UTC day) counting impersonation sessions the
 *   admin started that day. The support service increments it with a single
 *   conditional `findOneAndUpdate` (`count < cap`), so concurrent starts can
 *   never exceed the daily cap (no count-then-write race).
 *
 * KEY
 *   `_id` is `<adminId>:<YYYY-MM-DD>` - the natural primary key makes the
 *   upsert race safe (a concurrent first insert fails with E11000 and the
 *   service retries the conditional increment).
 *
 * INDEXES
 *   - TTL on `expiresAt` (a few days after the counted day)
 *   - { adminId: 1, day: -1 }
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'SupportImpersonationCounter';

const supportImpersonationCounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    adminId: { type: String, required: true },
    day: { type: String, required: true },
    count: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

supportImpersonationCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
supportImpersonationCounterSchema.index({ adminId: 1, day: -1 });

supportImpersonationCounterSchema.plugin(paginate);

export const SupportImpersonationCounterSchema = supportImpersonationCounterSchema;
export const SupportImpersonationCounter = mongoose.models[MODEL_NAME]
  || mongoose.model(MODEL_NAME, supportImpersonationCounterSchema);
export default SupportImpersonationCounter;
