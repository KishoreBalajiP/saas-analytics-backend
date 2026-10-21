/**
 * OutboundEmail repository (roadmap 2.7 - email outbox).
 *
 * PURPOSE
 *   Data access for the email outbox. Every state transition is one atomic
 *   `findOneAndUpdate`, so two drains (two worker instances, or the
 *   dispatch-on-enqueue path racing the scheduled drain) can never both
 *   claim the same message.
 *
 * CODING GUIDELINES
 *   - Reads are lean. Callers never receive `variablesEnc` through `list`.
 *   - The outbox is platform infrastructure; listing across tenants is a
 *     platform-admin (monitoring) surface only.
 */

import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import {
  OutboundEmail,
  OUTBOX_CLAIMABLE_STATUSES,
  OUTBOX_STATUSES,
} from '../models/OutboundEmail.js';

/** Insert a new message. Throws the driver's duplicate-key error (11000) on a reused dedupe key. */
export const create = async (data) => {
  const doc = await OutboundEmail.create(data);
  return doc.toObject();
};

export const findById = (id) => (mongoose.isValidObjectId(id) ? OutboundEmail.findById(id).lean() : null);

export const findByDedupeKey = (dedupeKey) => OutboundEmail.findOne({ dedupeKey }).lean();

/** Claim filter: due pending/retrying messages, or a send whose lease expired. */
function claimableFilter(now) {
  return {
    $or: [
      { status: { $in: [...OUTBOX_CLAIMABLE_STATUSES] }, nextAttemptAt: { $lte: now } },
      { status: 'sending', lockedUntil: { $lte: now } },
    ],
  };
}

/**
 * Atomically claim one due message (or the given one, when it is due) for
 * `owner`, taking a lease and counting the attempt. `lockedBy` gets a
 * per-claim token (`<owner>:<uuid>`), so the outcome of a claim whose lease
 * expired and was re-claimed can no longer be written.
 *
 * @param {Object} opts
 * @param {Date} opts.now
 * @param {string} opts.owner - instance id of the claimer.
 * @param {number} opts.leaseMs
 * @param {string} [opts.id] - claim only this message.
 * @returns {Promise<Object|null>} the claimed message (after update) or null.
 */
export const claimNext = async ({ now, owner, leaseMs, id = null }) => {
  const filter = claimableFilter(now);
  if (id) {
    if (!mongoose.isValidObjectId(id)) return null;
    filter._id = new mongoose.Types.ObjectId(String(id));
  }
  return OutboundEmail.findOneAndUpdate(
    filter,
    {
      $set: {
        status: 'sending',
        lockedBy: `${owner}:${randomUUID()}`,
        lockedUntil: new Date(now.getTime() + leaseMs),
        lastAttemptAt: now,
      },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1, _id: 1 } },
  ).lean();
};

/** The claim a transition applies to (`lockToken` = the claim's `lockedBy`). */
const claimed = (id, lockToken) => ({ _id: id, status: 'sending', ...(lockToken ? { lockedBy: lockToken } : {}) });

/** Record a successful send; the encrypted variables are dropped. */
export const markSent = (id, { now, messageId = null, transport = null, lockToken = null }) =>
  OutboundEmail.findOneAndUpdate(
    claimed(id, lockToken),
    {
      $set: {
        status: 'sent',
        sentAt: now,
        messageId,
        transport,
        lockedBy: null,
        lockedUntil: null,
        lastError: null,
        variablesEnc: null,
      },
    },
    { new: true },
  ).lean();

/** Schedule another attempt after a transient failure. */
export const markRetry = (id, { nextAttemptAt, error, lockToken = null }) =>
  OutboundEmail.findOneAndUpdate(
    claimed(id, lockToken),
    { $set: { status: 'retrying', nextAttemptAt, lastError: error, lockedBy: null, lockedUntil: null } },
    { new: true },
  ).lean();

/** Dead-letter a message (attempts exhausted or a permanent failure). */
export const markDead = (id, { now, error, lockToken = null }) =>
  OutboundEmail.findOneAndUpdate(
    lockToken ? claimed(id, lockToken) : { _id: id, status: { $in: ['sending', 'pending', 'retrying'] } },
    { $set: { status: 'dead', deadAt: now, lastError: error, lockedBy: null, lockedUntil: null } },
    { new: true },
  ).lean();

/** Put a dead-lettered message back in the queue with a fresh attempt budget. */
export const requeueDead = (id, { now }) =>
  OutboundEmail.findOneAndUpdate(
    { _id: id, status: 'dead' },
    { $set: { status: 'pending', attempts: 0, nextAttemptAt: now, deadAt: null, lockedBy: null, lockedUntil: null } },
    { new: true },
  ).lean();

/** Count messages per status (every status present, zero-filled). */
export const countByStatus = async () => {
  const rows = await OutboundEmail.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const out = Object.fromEntries(OUTBOX_STATUSES.map((s) => [s, 0]));
  for (const row of rows) if (row._id in out) out[row._id] = row.count;
  return out;
};

/** The longest-waiting due message (backlog age signal). */
export const oldestDue = (now) =>
  OutboundEmail.findOne({ status: { $in: [...OUTBOX_CLAIMABLE_STATUSES] }, nextAttemptAt: { $lte: now } })
    .sort({ nextAttemptAt: 1 })
    .select({ _id: 1, nextAttemptAt: 1, createdAt: 1 })
    .lean();

/** Most recent successful send. */
export const lastSent = () =>
  OutboundEmail.findOne({ status: 'sent' }).sort({ sentAt: -1 }).select({ _id: 1, sentAt: 1 }).lean();

/** Paginated listing for the monitoring surface (never returns variables). */
export const list = async ({ filter = {}, page = 1, limit = 20 } = {}) => {
  const result = await OutboundEmail.paginate(filter, {
    page,
    limit,
    lean: true,
    sort: { createdAt: -1 },
    select: '-variablesEnc',
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

export default {
  create,
  findById,
  findByDedupeKey,
  claimNext,
  markSent,
  markRetry,
  markDead,
  requeueDead,
  countByStatus,
  oldestDue,
  lastSent,
  list,
};
