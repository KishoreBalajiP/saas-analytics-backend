/**
 * Auth cooldown service (auth.15, adminauth).
 *
 * PURPOSE
 *   "May this action run again yet?" for auth emails, backed by the
 *   `AuthCooldown` collection so the answer is the same on every instance.
 *
 * CONTRACT
 *   acquire(key, ttlMs) -> true when the caller may proceed (and the
 *   cooldown now runs for `ttlMs`), false while an earlier cooldown for the
 *   same key is still running. Atomic: of two concurrent callers exactly
 *   one gets true.
 */

import { AuthCooldown } from '../models/AuthCooldown.js';

/**
 * @param {string} key - non-secret identifier (digest emails before use).
 * @param {number} ttlMs - cooldown length; <= 0 always allows.
 * @param {Date} [now]
 * @returns {Promise<boolean>}
 */
export async function acquire(key, ttlMs, now = new Date()) {
  if (typeof key !== 'string' || key.length === 0) throw new Error('authCooldown.acquire requires a key');
  if (!(Number(ttlMs) > 0)) return true;
  const expiresAt = new Date(now.getTime() + Number(ttlMs));
  // Take over a marker whose cooldown has ended but that the TTL monitor
  // (which runs about once a minute) has not purged yet.
  const takenOver = await AuthCooldown.findOneAndUpdate(
    { key, expiresAt: { $lte: now } },
    { $set: { expiresAt } },
    { new: true, lean: true },
  );
  if (takenOver) return true;
  try {
    await AuthCooldown.create({ key, expiresAt });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

/**
 * Remaining cooldown in ms for a key (0 when none is running).
 *
 * @param {string} key
 * @param {Date} [now]
 * @returns {Promise<number>}
 */
export async function remainingMs(key, now = new Date()) {
  const row = await AuthCooldown.findOne({ key }).lean();
  if (!row) return 0;
  return Math.max(0, new Date(row.expiresAt).getTime() - now.getTime());
}

export default { acquire, remainingMs };
