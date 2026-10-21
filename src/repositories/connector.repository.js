/**
 * Connector Repository (Sprint 4 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for persisted connectors (`models/Connector.js`).
 *   Owns every read/write against the Connector collection.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - list, findById, findByTenant, findByWebhookToken, create, update,
 *     softDelete, countByType, bumpError.
 *   - Sync slot + lease: markSyncQueued / markSyncRunning / renewSyncLease /
 *     markSyncFailed, and the reaper's findStaleSyncs / resetStaleSync.
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - `config` is stored as the encrypted envelope string; encryption/decryption
 *     is the service's job, this layer never touches secrets.
 *   - Tenant scoping is explicit (`tenantId: { $eq }`) plus the `tenantScope`
 *     plugin as a second line of defence.
 */

import { Connector } from '../models/Connector.js';

/** Paginated connector list for a tenant. */
export const list = async ({ tenantId, filter = {}, page = 1, limit = 20 } = {}) => {
  const query = { tenantId, ...filter };
  const result = await Connector.paginate(query, {
    page,
    limit,
    lean: true,
    sort: { createdAt: -1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Find a connector by id within a tenant. */
export const findById = (id, { tenantId } = {}) =>
  Connector.findOne({ _id: id, ...(tenantId ? { tenantId } : {}) }).lean();

/** Find a connector by its public webhook token. */
export const findByWebhookToken = (token) => Connector.findOne({ webhookToken: token }).lean();

/** Create a connector. Returns the saved plain document. */
export const create = async (data) => {
  const doc = new Connector(data);
  await doc.save();
  return doc.toObject();
};

/** Apply a patch to a connector. Returns the updated lean doc or null. */
export const update = (id, patch) =>
  Connector.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

const SYNC_IN_FLIGHT = ['queued', 'running'];
const DEFAULT_SYNC_LEASE_MS = 15 * 60 * 1000;

/**
 * Predicate for "this connector's queued/running sync has lost its lease":
 * the lease expired, or (records written before leases existed) the request
 * is older than one lease.
 */
const syncLeaseExpired = (now, leaseMs) => ({
  $or: [
    { syncLeaseUntil: { $lte: now } },
    { syncLeaseUntil: null, syncRequestedAt: { $lte: new Date(now.getTime() - leaseMs) } },
    { syncLeaseUntil: null, syncRequestedAt: null },
  ],
});

/**
 * Atomically take the connector's sync slot. Succeeds when no sync is in
 * flight, or the in-flight one lost its lease (a crashed worker can no longer
 * wedge the connector). Returns the updated doc or null when a live sync
 * already holds the slot.
 */
export const markSyncQueued = (id, {
  requestedAt,
  by = null,
  tenantId,
  leaseMs = DEFAULT_SYNC_LEASE_MS,
  syncRunId = null,
}) =>
  Connector.findOneAndUpdate(
    {
      _id: id,
      ...(tenantId ? { tenantId } : {}),
      $or: [
        { syncStatus: { $nin: SYNC_IN_FLIGHT } },
        { syncStatus: { $in: SYNC_IN_FLIGHT }, ...syncLeaseExpired(requestedAt, leaseMs) },
      ],
    },
    {
      $set: {
        syncStatus: 'queued',
        syncRequestedAt: requestedAt,
        syncLeaseUntil: new Date(requestedAt.getTime() + leaseMs),
        currentSyncRunId: syncRunId,
        lastError: null,
        updatedBy: by,
      },
    },
    { new: true, runValidators: true, lean: true },
  );

export const markSyncFailed = (id, { requestedAt, message }) =>
  Connector.findOneAndUpdate(
    { _id: id, syncStatus: 'queued', syncRequestedAt: requestedAt },
    { $set: { syncStatus: 'failed', lastError: message, syncLeaseUntil: null, currentSyncRunId: null } },
    { new: true, runValidators: true, lean: true },
  );

/**
 * Sync-slot writes are conditional on WHO holds the slot: `owner` is the
 * SyncRun id that queued the sync (`currentSyncRunId`), or null for
 * untracked work (webhook ingests), which only touches the slot while no
 * tracked sync holds it. A worker whose run was superseded therefore can
 * never overwrite the newer run's state.
 */
const slotFilter = (id, owner) => ({ _id: id, currentSyncRunId: owner ?? null });

/** Worker picked the sync up: running, with a fresh lease. */
export const markSyncRunning = (id, { owner = null, leaseUntil }) =>
  Connector.findOneAndUpdate(
    slotFilter(id, owner),
    { $set: { syncStatus: 'running', syncLeaseUntil: leaseUntil } },
    { new: true, lean: true },
  );

/** Extend the lease of a sync that is still in flight (worker heartbeat). */
export const renewSyncLease = (id, { owner = null, leaseUntil, status = null }) =>
  Connector.updateOne(
    { ...slotFilter(id, owner), syncStatus: { $in: SYNC_IN_FLIGHT } },
    { $set: { syncLeaseUntil: leaseUntil, ...(status ? { syncStatus: status } : {}) } },
  );

/** Finish the slot (succeeded/failed/...) when `owner` still holds it. */
export const releaseSyncSlot = (id, { owner = null, patch }) =>
  Connector.findOneAndUpdate(
    slotFilter(id, owner),
    { $set: { syncLeaseUntil: null, currentSyncRunId: null, ...patch } },
    { new: true, lean: true },
  );

/**
 * Platform-wide scan (stale-job reaper): connectors whose queued/running sync
 * lost its lease. Lean candidates only; reset each with `resetStaleSync`.
 */
export const findStaleSyncs = ({ now = new Date(), leaseMs = DEFAULT_SYNC_LEASE_MS, limit = 200 } = {}) =>
  Connector.find({ syncStatus: { $in: SYNC_IN_FLIGHT }, ...syncLeaseExpired(now, leaseMs) })
    .sort({ syncLeaseUntil: 1 })
    .limit(limit)
    .lean();

/**
 * Atomically reset one stale sync (still in flight AND still past its lease,
 * so two reapers, or a worker that just renewed, can never both act).
 */
export const resetStaleSync = (id, { now = new Date(), leaseMs = DEFAULT_SYNC_LEASE_MS, patch }) =>
  Connector.findOneAndUpdate(
    { _id: id, syncStatus: { $in: SYNC_IN_FLIGHT }, ...syncLeaseExpired(now, leaseMs) },
    { $set: patch },
    { new: true, lean: true },
  );

/** Record an ingestion failure on a connector (error counter + lastError). */
export const bumpError = async (id, message) =>
  Connector.findByIdAndUpdate(
    id,
    {
      $set: { lastError: message, updatedAt: new Date() },
      $inc: { errorCount: 1 },
    },
    { new: true, lean: true },
  );

/**
 * Increment a connector's dataset version (its rows changed). Uses a plain
 * `$inc` so concurrent syncs never lose a bump.
 */
export const bumpDataVersion = (id, tenantId) =>
  Connector.updateOne({ _id: id, tenantId }, { $inc: { dataVersion: 1 } });

/**
 * Dataset versions for a tenant's connectors, sorted by id. With
 * `connectorIds` only those connectors are read; otherwise every live
 * connector of the tenant (a tenant-wide query reads all of them).
 *
 * @returns {Promise<Array<{ id: string, version: number }>>}
 */
export const dataVersions = async (tenantId, connectorIds = []) => {
  const filter = { tenantId };
  const ids = (connectorIds || []).map(String).filter((id) => /^[0-9a-fA-F]{24}$/.test(id));
  if (ids.length) filter._id = { $in: ids };
  const docs = await Connector.find(filter).select('_id dataVersion').lean();
  return docs
    .map((doc) => ({ id: String(doc._id), version: doc.dataVersion ?? 0 }))
    .sort((a, b) => a.id.localeCompare(b.id));
};

/** Soft-delete a connector. Returns the plain doc or null. */
export const remove = async (id, by) => {
  const doc = await Connector.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/** Count connectors by type within a tenant. */
export const countByType = async (tenantId) => {
  const docs = await Connector.aggregate([
    { $match: { tenantId } },
    { $group: { _id: '$type', count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(docs.map((d) => [d._id, d.count]));
};

export default {
  list,
  findById,
  findByWebhookToken,
  create,
  update,
  markSyncQueued,
  markSyncFailed,
  markSyncRunning,
  renewSyncLease,
  releaseSyncSlot,
  findStaleSyncs,
  resetStaleSync,
  bumpError,
  bumpDataVersion,
  dataVersions,
  remove,
  countByType,
  _meta: { leanReturns: true, tenancy: 'tenant', encryptedFields: ['config'] },
};
