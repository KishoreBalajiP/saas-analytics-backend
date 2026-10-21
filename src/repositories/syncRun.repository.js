/**
 * SyncRun Repository (roadmap 1.4).
 *
 * PURPOSE
 *   Data access for connector sync-run records (`models/SyncRun.js`).
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Tenant reads REQUIRE a tenantId (explicit filter plus the tenantScope
 *     plugin). Worker/reaper writes address a run by id and guard on its
 *     current status, so a terminal run is never reopened.
 */

import mongoose from 'mongoose';
import { SyncRun, SYNC_RUN_OPEN_STATUSES } from '../models/SyncRun.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function requireTenant(tenantId) {
  if (!tenantId) throw new Error('syncRunRepository: tenantId is required');
}

/** Generate an id up front so the connector claim can reference the run. */
export const newId = () => new mongoose.Types.ObjectId().toString();

/** Create a run. */
export const create = async (data) => {
  requireTenant(data?.tenantId);
  const doc = new SyncRun(data);
  await doc.save();
  return doc.toObject();
};

/** One run within a tenant. */
export const findById = (id, { tenantId } = {}) => {
  requireTenant(tenantId);
  if (!mongoose.isValidObjectId(id)) return Promise.resolve(null);
  return SyncRun.findOne({ _id: id, tenantId }).lean();
};

/** The run recorded for a queue job id (untracked messages, retries). */
export const findByJobId = ({ tenantId, connectorId, jobId }) => {
  requireTenant(tenantId);
  if (!jobId) return Promise.resolve(null);
  return SyncRun.findOne({ tenantId, connectorId: String(connectorId), jobId: String(jobId) })
    .sort({ createdAt: -1 })
    .lean();
};

/** Paginated history for one connector (newest first). */
export const listForConnector = async ({ tenantId, connectorId, status, page = 1, limit = 20 } = {}) => {
  requireTenant(tenantId);
  const filter = { tenantId, connectorId: String(connectorId) };
  if (status) filter.status = status;
  const result = await SyncRun.paginate(filter, { page, limit, lean: true, sort: { createdAt: -1 } });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/**
 * Move an open run to `running` for the given attempt. Returns null when the
 * run is already terminal (reaped/cancelled), so a stale queue message can
 * be skipped.
 */
export const markRunning = (id, { attempt, maxAttempts = null, instanceId = null, now = new Date(), leaseUntil }) =>
  SyncRun.findOneAndUpdate(
    { _id: id, status: { $in: [...SYNC_RUN_OPEN_STATUSES] } },
    [
      {
        $set: {
          status: 'running',
          attempts: attempt,
          maxAttempts: maxAttempts ?? '$maxAttempts',
          instanceId,
          startedAt: { $ifNull: ['$startedAt', now] },
          heartbeatAt: now,
          leaseUntil,
          error: null,
        },
      },
    ],
    { new: true, lean: true },
  );

/** Renew the lease of a running run. */
export const heartbeat = (id, { now = new Date(), leaseUntil }) =>
  SyncRun.updateOne({ _id: id, status: 'running' }, { $set: { heartbeatAt: now, leaseUntil } });

/** Record a failed attempt that the queue will retry. */
export const markRetrying = (id, { error, leaseUntil }) =>
  SyncRun.findOneAndUpdate(
    { _id: id, status: 'running' },
    { $set: { status: 'retrying', error, leaseUntil } },
    { new: true, lean: true },
  );

/**
 * Close an open run with a terminal status. Returns the updated doc or null
 * when the run was already closed.
 */
export const finish = (id, { status, finishedAt = new Date(), rows, error = null, retentionDays = 90 }) =>
  SyncRun.findOneAndUpdate(
    { _id: id, status: { $in: [...SYNC_RUN_OPEN_STATUSES] } },
    [
      {
        $set: {
          status,
          finishedAt,
          durationMs: {
            $cond: [{ $ifNull: ['$startedAt', false] }, { $subtract: [finishedAt, '$startedAt'] }, null],
          },
          ...(rows ? { rows: { $literal: rows } } : {}),
          error: error ? { $literal: error } : null,
          leaseUntil: null,
          expiresAt: new Date(finishedAt.getTime() + retentionDays * DAY_MS),
        },
      },
    ],
    { new: true, lean: true },
  );

/** Open runs of one connector (reaper: close whatever the dead worker left). */
export const findOpenForConnector = ({ tenantId, connectorId }) => {
  requireTenant(tenantId);
  return SyncRun.find({ tenantId, connectorId: String(connectorId), status: { $in: [...SYNC_RUN_OPEN_STATUSES] } })
    .sort({ createdAt: -1 })
    .lean();
};

export default {
  newId,
  create,
  findById,
  findByJobId,
  listForConnector,
  markRunning,
  heartbeat,
  markRetrying,
  finish,
  findOpenForConnector,
  _meta: { leanReturns: true, tenancy: 'tenant' },
};
