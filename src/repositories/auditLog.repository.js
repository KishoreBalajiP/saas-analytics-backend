/**
 * Audit Log Repository (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Stable, append-only data-access surface for the audit trail. Reads
 *   service the `/audit-logs` API. Writes happen via the audit service.
 *
 * RESPONSIBILITY
 *   - insert(event), insertMany(events)
 *   - list(filters), findById, listByModule(module, filters)
 *   - countByAction / countByActor (analytics)
 *   - retentionPurge({ before })   (privileged, queued)
 *
 * CODING GUIDELINES
 *   - NO update / delete except through `retentionPurge`, and only when
 *     the retention window has elapsed (Phase 3 setting). The model's
 *     append-only pre-hooks reject every other mutation.
 *   - Reads always sort by `occurredAt` (the paginate plugin's default
 *     `-createdAt` does not exist on this model).
 *
 * FUTURE EXTENSION
 *   - Time-series collection (Mongo 5.0+).
 *   - Tamper-evidence hash chain.
 */

import { AuditLog } from '../models/AuditLog.js';

/** Insert a single audit event. Returns the saved plain document. */
export const insert = async (event) => {
  const doc = new AuditLog(event);
  await doc.save();
  return doc.toObject();
};

/** Bulk-insert audit events (raw path, avoids per-doc save middleware). */
export const insertMany = async (events) => {
  if (events.length === 0) return [];
  const docs = await AuditLog.insertMany(events, { ordered: false });
  return docs.map((d) => d.toObject());
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
 * bypass the append-only guard; must never be exposed to requests.
 *
 * @param {{ before: Date }} options
 * @returns {Promise<{ deletedCount: number }>}
 */
export const retentionPurge = async ({ before }) =>
  AuditLog.deleteMany({ occurredAt: { $lt: before } }).setOptions({ bypassAuditAppendOnly: true });

export default {
  insert,
  insertMany,
  list,
  findById,
  listByModule,
  countByAction,
  countByActor,
  retentionPurge,
  _meta: { appendOnly: true, retentionDriven: true },
};
