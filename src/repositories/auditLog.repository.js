/**
 * Audit Log Repository (Sprint 2 - implemented; roadmap 2.5 - hash chain).
 *
 * PURPOSE
 *   Stable, append-only data-access surface for the audit trail. Reads
 *   service the `/audit-logs` API. Writes happen via the audit service.
 *
 * RESPONSIBILITY
 *   - insert(event), insertMany(events)   (hash-chained, see below)
 *   - list(filters), findById, listByModule(module, filters)
 *   - countByAction / countByActor (analytics)
 *   - chain reads for verification: findChainHead, streamChain,
 *     countUnchainedSince
 *   - retentionPurge({ before })   (privileged, queued)
 *
 * HASH CHAIN
 *   Every insert is sealed with the next `seq`, the previous row's hash as
 *   `prevHash`, and its own `hash` (`utils/auditChain.js`). Inserts are
 *   serialised inside this process (one promise queue) and the unique index
 *   on `seq` serialises them across processes: a writer that loses a race
 *   gets a duplicate-key error, re-reads the head and retries. The last
 *   known head is cached, so a write normally costs one round trip.
 *
 * CODING GUIDELINES
 *   - NO update / delete except through `retentionPurge`, and only when
 *     the retention window has elapsed. The model's append-only pre-hooks
 *     reject every other mutation.
 *   - Never insert through the model directly: unchained rows show up as
 *     `unchained_record` errors in verification.
 *   - Reads always sort by `occurredAt` (the paginate plugin's default
 *     `-createdAt` does not exist on this model).
 */

import { AuditLog } from '../models/AuditLog.js';
import { GENESIS_HASH, seal } from '../utils/auditChain.js';

const MAX_CHAIN_ATTEMPTS = 10;

/** Last row this process sealed (or read): `{ seq, hash }`; null = unknown. */
let chainHead = null;
/** Serialises inserts inside this process. */
let writeQueue = Promise.resolve();

/** Read the current chain head from the database. */
export const findChainHead = async () => {
  const last = await AuditLog.findOne({ seq: { $type: 'number' } })
    .sort({ seq: -1 })
    .select('seq hash')
    .lean();
  return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS_HASH };
};

function isSeqConflict(err) {
  if (err?.code !== 11000) return false;
  if (err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, 'seq')) return true;
  return /seq/.test(String(err.message));
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function insertChained(event) {
  let lastError = null;
  for (let attempt = 0; attempt < MAX_CHAIN_ATTEMPTS; attempt += 1) {
    if (!chainHead) chainHead = await findChainHead();
    const doc = new AuditLog({ ...event, occurredAt: event.occurredAt ?? new Date() });
    const next = seal(doc, chainHead);
    try {
      await doc.save();
      chainHead = next;
      return doc.toObject();
    } catch (err) {
      if (!isSeqConflict(err)) throw err;
      // Another process appended first: re-read the head and try again.
      lastError = err;
      chainHead = null;
      await pause(2 + Math.floor(Math.random() * 10 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Insert a single audit event (sealed into the chain). Returns the saved plain document. */
export const insert = (event) => {
  const run = writeQueue.then(() => insertChained(event));
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
};

/** Insert several audit events in order (each sealed into the chain). */
export const insertMany = async (events) => {
  const saved = [];
  for (const event of events) saved.push(await insert(event));
  return saved;
};

/**
 * Cursor over chained rows in `seq` order (verification only).
 *
 * @param {Object} [opts]
 * @param {number} [opts.fromSeq=1]
 * @param {number} [opts.batchSize=500]
 */
export const streamChain = ({ fromSeq = 1, batchSize = 500 } = {}) =>
  AuditLog.find({ seq: { $type: 'number', $gte: fromSeq } })
    .sort({ seq: 1 })
    .lean()
    .cursor({ batchSize });

/** Rows without chain data written at or after `since` (inserted around the chain). */
export const countUnchainedSince = (since) =>
  AuditLog.countDocuments({
    seq: { $exists: false },
    ...(since ? { occurredAt: { $gte: since } } : {}),
  });

/** Up to `limit` ids of unchained rows written at or after `since`. */
export const findUnchainedSince = (since, limit = 20) =>
  AuditLog.find({ seq: { $exists: false }, ...(since ? { occurredAt: { $gte: since } } : {}) })
    .sort({ occurredAt: 1 })
    .limit(limit)
    .select('_id occurredAt module action')
    .lean();

/** Forget the cached head (tests; or after a maintenance restore). */
export const resetChainCache = () => {
  chainHead = null;
};

/** Paginated, filtered audit list. */
export const list = async ({ filter = {}, page = 1, limit = 20 } = {}) => {
  const result = await AuditLog.paginate(filter, {
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

/** Find a single audit entry by id. */
export const findById = (id) => AuditLog.findById(id).lean();

/** List entries for one module (e.g. `iam.tenants`). */
export const listByModule = (module, filters = {}, opts = {}) =>
  list({ ...filters, filter: { ...(filters.filter ?? {}), module }, ...opts });

/** Count entries matching module/action/tenant/time filters. */
export const countByAction = async ({ tenantId, module, action, from, to } = {}) => {
  const filter = {};
  if (tenantId != null) filter.tenantId = tenantId;
  if (module) filter.module = module;
  if (action) filter.action = action;
  if (from || to) filter.occurredAt = {};
  if (from) filter.occurredAt.$gte = new Date(from);
  if (to) filter.occurredAt.$lte = new Date(to);
  if (from || to) {
    if (Object.keys(filter.occurredAt).length === 0) delete filter.occurredAt;
  }
  return AuditLog.countDocuments(filter);
};

/** Count entries for one actor within optional tenant/time filters. */
export const countByActor = async ({ actorId, tenantId, from, to } = {}) => {
  const filter = { actorId };
  if (tenantId != null) filter.tenantId = tenantId;
  if (from || to) filter.occurredAt = {};
  if (from) filter.occurredAt.$gte = new Date(from);
  if (to) filter.occurredAt.$lte = new Date(to);
  if (from || to) {
    if (Object.keys(filter.occurredAt).length === 0) delete filter.occurredAt;
  }
  return AuditLog.countDocuments(filter);
};

/**
 * Hard-delete entries older than `before`. The ONLY write path allowed to
 * bypass the append-only guard; must never be exposed to requests. The
 * chain stays verifiable: verification anchors on the first remaining row
 * (`anchored: true` in its report) and checks every link after it.
 *
 * @param {{ before: Date }} options
 * @returns {Promise<{ deletedCount: number }>}
 */
export const retentionPurge = async ({ before }) =>
  AuditLog.deleteMany({ occurredAt: { $lt: before } }).setOptions({ bypassAuditAppendOnly: true });

export default {
  insert,
  insertMany,
  findChainHead,
  streamChain,
  countUnchainedSince,
  findUnchainedSince,
  resetChainCache,
  list,
  findById,
  listByModule,
  countByAction,
  countByActor,
  retentionPurge,
  _meta: { appendOnly: true, retentionDriven: true, hashChained: true },
};
