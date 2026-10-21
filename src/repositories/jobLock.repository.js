/**
 * JobLock Repository (roadmap 1.4).
 *
 * PURPOSE
 *   MongoDB primitives behind the lease lock in `src/jobs/lock.js`. Every
 *   operation is a single atomic document write keyed by the lock name.
 *
 * ACQUIRE
 *   `findOneAndUpdate({ _id, lockedUntil <= now }, $set, { upsert: true })`:
 *     - lock free or expired -> the update matches and we take it;
 *     - no document yet      -> the upsert inserts it and we take it;
 *     - held by someone else -> the filter misses, the upsert collides on
 *       `_id` (E11000) and we report "not acquired".
 */

import { JobLock } from '../models/JobLock.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Try to take the lock. Returns true when `token` now owns it.
 *
 * @returns {Promise<boolean>}
 */
export const acquire = async (key, { owner, token, leaseMs, now = new Date() }) => {
  const lockedUntil = new Date(now.getTime() + leaseMs);
  try {
    const doc = await JobLock.findOneAndUpdate(
      { _id: key, lockedUntil: { $lte: now } },
      {
        $set: {
          owner,
          token,
          lockedUntil,
          acquiredAt: now,
          expiresAt: new Date(lockedUntil.getTime() + DAY_MS),
        },
      },
      { upsert: true, new: true, lean: true },
    );
    return doc?.token === token;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
};

/** Extend the lease when `token` still owns the lock. */
export const renew = async (key, { token, leaseMs, now = new Date() }) => {
  const lockedUntil = new Date(now.getTime() + leaseMs);
  const result = await JobLock.updateOne(
    { _id: key, token, lockedUntil: { $gt: now } },
    { $set: { lockedUntil, expiresAt: new Date(lockedUntil.getTime() + DAY_MS) } },
  );
  return (result.modifiedCount ?? 0) === 1;
};

/**
 * Release the lock owned by `token`. With `holdUntil` in the future the lock
 * stays taken until then (tick fencing) instead of becoming free at once.
 */
export const release = async (key, { token, holdUntil = null, now = new Date() }) => {
  const until = holdUntil && holdUntil > now ? holdUntil : now;
  const result = await JobLock.updateOne(
    { _id: key, token },
    { $set: { lockedUntil: until, token: holdUntil && holdUntil > now ? token : null } },
  );
  return (result.modifiedCount ?? 0) === 1;
};

/** Current lock documents (monitoring). */
export const listActive = ({ now = new Date() } = {}) =>
  JobLock.find({ lockedUntil: { $gt: now } }).sort({ _id: 1 }).lean();

export default {
  acquire,
  renew,
  release,
  listActive,
  _meta: { leanReturns: true, tenancy: 'platform' },
};
