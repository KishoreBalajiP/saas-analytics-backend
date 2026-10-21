/**
 * JobRun Repository (roadmap 1.4).
 *
 * PURPOSE
 *   Data access for scheduled-job execution records (`models/JobRun.js`).
 *   Platform-scoped: job runs have no tenant.
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Status transitions are conditional on the run still being `running`, so
 *     a late finish can never overwrite a reaper's `abandoned` verdict.
 */

import { JobRun } from '../models/JobRun.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Create a `running` record. */
export const create = async (data) => {
  const doc = new JobRun(data);
  await doc.save();
  return doc.toObject();
};

/** Extend the lease of a running record (heartbeat). */
export const heartbeat = (id, { now = new Date(), leaseUntil }) =>
  JobRun.updateOne({ _id: id, status: 'running' }, { $set: { heartbeatAt: now, leaseUntil } });

/**
 * Close a running record. Returns the updated doc or null when the run was
 * already closed (for example abandoned by the reaper).
 */
export const finish = (id, { status, finishedAt = new Date(), durationMs = null, counts = null, error = null, retentionDays = 30 }) =>
  JobRun.findOneAndUpdate(
    { _id: id, status: 'running' },
    {
      $set: {
        status,
        finishedAt,
        durationMs,
        counts,
        error,
        leaseUntil: null,
        expiresAt: new Date(finishedAt.getTime() + retentionDays * DAY_MS),
      },
    },
    { new: true, lean: true },
  );

/** Mark every running record whose lease expired as `abandoned`. */
export const closeStale = async ({ now = new Date(), retentionDays = 30 } = {}) => {
  const result = await JobRun.updateMany(
    { status: 'running', leaseUntil: { $lte: now } },
    {
      $set: {
        status: 'abandoned',
        finishedAt: now,
        error: { code: 'LEASE_EXPIRED', message: 'The process running this job stopped before it finished' },
        leaseUntil: null,
        expiresAt: new Date(now.getTime() + retentionDays * DAY_MS),
      },
    },
  );
  return result.modifiedCount ?? 0;
};

/** Paginated listing (newest first) with optional job/status filters. */
export const list = async ({ filter = {}, page = 1, limit = 20 } = {}) => {
  const result = await JobRun.paginate(filter, { page, limit, lean: true, sort: { startedAt: -1 } });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/**
 * Latest run, latest success and latest failure for each named job.
 *
 * @param {string[]} jobs
 * @returns {Promise<Record<string, { lastRun: Object|null, lastSuccess: Object|null, lastFailure: Object|null }>>}
 */
export const latestByJob = async (jobs = []) => {
  const out = {};
  await Promise.all(jobs.map(async (job) => {
    const [lastRun, lastSuccess, lastFailure] = await Promise.all([
      JobRun.findOne({ job }).sort({ startedAt: -1 }).lean(),
      JobRun.findOne({ job, status: 'succeeded' }).sort({ startedAt: -1 }).lean(),
      JobRun.findOne({ job, status: { $in: ['failed', 'abandoned'] } }).sort({ startedAt: -1 }).lean(),
    ]);
    out[job] = { lastRun, lastSuccess, lastFailure };
  }));
  return out;
};

export default {
  create,
  heartbeat,
  finish,
  closeStale,
  list,
  latestByJob,
  _meta: { leanReturns: true, tenancy: 'platform' },
};
