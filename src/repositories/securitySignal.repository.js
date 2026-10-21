/**
 * SecuritySignal Repository (roadmap 2.6).
 *
 * PURPOSE
 *   Batched `$inc` upserts of per-minute request counters (written by
 *   `services/securityDetection/signals.js`) and the windowed reads the
 *   request-level detection rules use.
 *
 * CODING GUIDELINES
 *   - Writes are unordered bulk upserts; a duplicate-key race between two
 *     instances flushing the same (kind, subject, bucket) is retried once
 *     as a plain update.
 *   - Reads return PLAIN objects and are always bounded by a bucket range.
 */

import { SecuritySignal, MAX_SET_ENTRIES } from '../models/SecuritySignal.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function toOperation(entry, retentionDays) {
  const update = {
    $inc: {
      count: entry.count ?? 0,
      clientErrors: entry.clientErrors ?? 0,
      serverErrors: entry.serverErrors ?? 0,
    },
    $setOnInsert: {
      tenantId: entry.tenantId ?? null,
      expiresAt: new Date(entry.bucket.getTime() + retentionDays * DAY_MS),
    },
  };
  const ipRanges = (entry.ipRanges ?? []).slice(0, MAX_SET_ENTRIES);
  const actors = (entry.actors ?? []).slice(0, MAX_SET_ENTRIES);
  if (ipRanges.length || actors.length) {
    update.$addToSet = {};
    if (ipRanges.length) update.$addToSet.ipRanges = { $each: ipRanges };
    if (actors.length) update.$addToSet.actors = { $each: actors };
  }
  return { filter: { kind: entry.kind, subject: entry.subject, bucket: entry.bucket }, update };
}

/**
 * Upsert a batch of aggregated counters.
 *
 * @param {Array<{ kind, subject, tenantId?, bucket: Date, count, clientErrors?, serverErrors?, ipRanges?, actors? }>} entries
 * @param {{ retentionDays?: number }} [options]
 * @returns {Promise<number>} rows written.
 */
export async function upsertMany(entries, { retentionDays = 35 } = {}) {
  if (!entries.length) return 0;
  const ops = entries.map((entry) => toOperation(entry, retentionDays));
  try {
    const result = await SecuritySignal.bulkWrite(
      ops.map(({ filter, update }) => ({ updateOne: { filter, update, upsert: true } })),
      { ordered: false },
    );
    return (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
  } catch (err) {
    const failed = new Set((err?.writeErrors ?? []).filter((e) => e?.code === 11000).map((e) => e.index));
    if (failed.size === 0) throw err;
    const retry = ops.filter((_, index) => failed.has(index));
    await SecuritySignal.bulkWrite(
      retry.map(({ filter, update }) => ({ updateOne: { filter, update, upsert: true } })),
      { ordered: false },
    );
    return ops.length;
  }
}

/** Subjects of `kind` with activity in (from, to] (capped). */
export const activeSubjects = async ({ kind, from, to, limit = 500 }) => {
  const rows = await SecuritySignal.aggregate([
    { $match: { kind, bucket: { $gt: from, $lte: to } } },
    { $group: { _id: '$subject' } },
    { $limit: limit },
  ]);
  return rows.map((row) => row._id);
};

/** Rows of `kind` for the given subjects in [from, to] (oldest first). */
export const findBuckets = ({ kind, subjects, from, to, limit = 20000 }) => {
  const filter = { kind, bucket: { $gte: from, $lte: to } };
  if (subjects) filter.subject = { $in: subjects };
  return SecuritySignal.find(filter).sort({ bucket: 1 }).limit(limit).lean();
};

/**
 * Per-subject totals of `kind` in [from, to): count, errors and the number
 * of buckets (baselines).
 */
export const totalsBySubject = async ({ kind, subjects, from, to }) => {
  const match = { kind, bucket: { $gte: from, $lt: to } };
  if (subjects) match.subject = { $in: subjects };
  const rows = await SecuritySignal.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$subject',
        count: { $sum: '$count' },
        clientErrors: { $sum: '$clientErrors' },
        serverErrors: { $sum: '$serverErrors' },
        ipRanges: { $addToSet: '$ipRanges' },
        firstBucket: { $min: '$bucket' },
      },
    },
  ]);
  return rows.map((row) => ({
    subject: row._id,
    count: row.count,
    clientErrors: row.clientErrors,
    serverErrors: row.serverErrors,
    ipRanges: [...new Set(row.ipRanges.flat())],
    firstBucket: row.firstBucket,
  }));
};

export default { upsertMany, activeSubjects, findBuckets, totalsBySubject };
