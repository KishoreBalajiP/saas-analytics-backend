/**
 * Access Log Repository (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Stable, high-volume data-access surface for per-request HTTP traces.
 *   Inserts are batched by the service; reads are lean.
 *
 * RESPONSIBILITY
 *   - insert(event), insertMany(events)   (batched)
 *   - list(filters), aggregateTopPaths(range), aggregateTopErrors(range)
 *   - countByActorWithin (support impersonation budget)
 *   - retentionPurge({ before })
 *
 * CODING GUIDELINES
 *   - Inserts MUST go through `insertMany` (the service buffers writes and
 *     flushes every N events / T milliseconds).
 *   - Reads are always lean. Aggregations use the collection's aggregation
 *     pipeline so they stay server-side.
 *   - Every list/aggregate accepts an explicit `tenantId` (or null for
 *     platform scope) - the caller decides the boundary, never the row.
 */

import { AccessLog } from '../models/AccessLog.js';

/** Insert a single capture (rare path; prefer the batched flush). */
export const insert = async (event) => {
  const doc = new AccessLog(event);
  await doc.save();
  return doc.toObject();
};

/** Bulk-insert captures (the hot path). Returns the saved plain docs. */
export const insertMany = async (events) => {
  if (events.length === 0) return [];
  const docs = await AccessLog.insertMany(events, { ordered: false });
  return docs.map((d) => d.toObject());
};

/**
 * Paginated, filtered access-log read. `filter` is caller-built and already
 * contains safe scalar values (see `services/accessLog.service#buildFilter`).
 */
export const list = async ({ filter = {}, page = 1, limit = 20 } = {}) => {
  const result = await AccessLog.paginate(filter, {
    page,
    limit,
    lean: true,
    sort: { occurredAt: -1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/**
 * Top-N paths by request count within a time range. `filter` carries the
 * optional tenant scope; `range` is { from, to } (both optional Dates).
 */
export const aggregateTopPaths = async ({ filter = {}, range = {}, limit = 10 } = {}) => {
  const match = buildRangeMatch(filter, range);
  const rows = await AccessLog.aggregate([
    { $match: match },
    { $group: { _id: '$path', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: Math.min(Number(limit) || 10, 100) },
    { $project: { _id: 0, path: '$_id', count: 1 } },
  ]);
  return rows;
};

/**
 * Top-N statusCode buckets with error counts within a time range. An error is
 * any statusCode >= 500 (server faults) or the captured error marker.
 */
export const aggregateTopErrors = async ({ filter = {}, range = {}, limit = 10 } = {}) => {
  const match = buildRangeMatch(filter, range);
  const rows = await AccessLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ['$error.code', { $cond: [{ $gte: ['$statusCode', 500] }, 'SERVER_5xx', 'OK'] }] },
        path: { $first: '$path' },
        count: { $sum: 1 },
        statusCodes: { $addToSet: '$statusCode' },
      },
    },
    { $sort: { count: -1 } },
    { $limit: Math.min(Number(limit) || 10, 100) },
    {
      $project: {
        _id: 0,
        code: '$_id',
        path: 1,
        count: 1,
        statusCodes: 1,
      },
    },
  ]);
  return rows;
};

/** Count captures for an actor within a time window (impersonation budget). */
export const countByActorWithin = async ({ actorId, event, from, to } = {}) => {
  const filter = { actorId };
  if (event) filter.event = event;
  if (from || to) filter.occurredAt = {};
  if (from) filter.occurredAt.$gte = new Date(from);
  if (to) filter.occurredAt.$lte = new Date(to);
  if (from || to && Object.keys(filter.occurredAt).length === 0) delete filter.occurredAt;
  return AccessLog.countDocuments(filter);
};

/**
 * Hard-delete captures older than `before` (retention). The ONLY write path
 * that removes rows; must never be exposed to requests.
 */
export const retentionPurge = async ({ before }) =>
  AccessLog.deleteMany({ occurredAt: { $lt: before } });

/* ------------------------------ internals ------------------------------- */

/** Merge the caller filter with an optional occurredAt range. */
function buildRangeMatch(filter, range) {
  const match = { ...filter };
  if (range?.from || range?.to) match.occurredAt = {};
  if (range?.from) match.occurredAt.$gte = new Date(range.from);
  if (range?.to) match.occurredAt.$lte = new Date(range.to);
  if ((range?.from || range?.to) && Object.keys(match.occurredAt).length === 0) {
    delete match.occurredAt;
  }
  return match;
}

export default {
  insert,
  insertMany,
  list,
  aggregateTopPaths,
  aggregateTopErrors,
  countByActorWithin,
  retentionPurge,
  _meta: { batchedWrites: true, appendOnly: true },
};
