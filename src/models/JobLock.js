/**
 * JobLock (roadmap 1.4 - distributed scheduling).
 *
 * PURPOSE
 *   Lease-based mutual exclusion for cron jobs when Redis is not configured.
 *   One document per lock key (`_id`, e.g. `job:report-schedule`). A process
 *   owns the lock while `lockedUntil` is in the future and its `token`
 *   matches; it renews the lease while the job runs and releases it when done.
 *   A crashed owner simply stops renewing, so the lease expires and the next
 *   tick on any instance takes the lock over.
 *
 *   With REDIS_URL set the same contract runs on Redis `SET NX PX`
 *   (`src/jobs/lock.js`); this collection is then unused.
 *
 * PLUGINS
 *   paginate (scheduler health lists current holders).
 *
 * INDEXES
 *   - TTL { expiresAt: 1 }  removes lock documents long after their lease.
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'JobLock';

const jobLockSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    owner: { type: String, default: null },
    token: { type: String, default: null },
    lockedUntil: { type: Date, required: true },
    acquiredAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

jobLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

jobLockSchema.plugin(paginate);

export const JobLockSchema = jobLockSchema;
export const JobLock = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, jobLockSchema);
export default JobLock;
