/**
 * Audit Export Repository (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Data-access surface for the audit export lifecycle. Rows are created
 *   when a request lands (`queued`) and advanced by the export queue
 *   consumer (`processing` -> `completed` | `failed`).
 *
 * CODING GUIDELINES
 *   - All status transitions use `findOneAndUpdate` so concurrent retries
 *     cannot double-advance a row.
 *   - Reads are tenant-aware: callers pass `tenantId` (or null for platform
 *     admins) and the repository scopes the lookup - never trust the row's
 *     stored tenant when serving a status request.
 */

import { AuditExport } from '../models/AuditExport.js';

/** Create an export request row. Returns the saved plain document. */
export const create = async (data) => {
  const doc = new AuditExport(data);
  await doc.save();
  return doc.toObject();
};

/**
 * Find an export by its public `exportId`, optionally scoped to a tenant.
 *
 * @param {string} exportId
 * @param {string|null} [tenantId] - null means "any tenant" (platform admin).
 * @returns {Promise<Object|null>}
 */
export const findByExportId = async (exportId, { tenantId = null } = {}) => {
  const filter = { exportId };
  if (tenantId != null) filter.tenantId = tenantId;
  return AuditExport.findOne(filter).lean();
};

/** Find by internal _id. */
export const findById = (id) => AuditExport.findById(id).lean();

/** Advance a row to `processing` (no-op if already processing/completed). */
export const markProcessing = async (exportId) =>
  AuditExport.findOneAndUpdate(
    { exportId, status: { $in: ['queued', 'processing'] } },
    { status: 'processing' },
    { new: true },
  ).lean();

/** Complete a row with the artifact metadata. */
export const markCompleted = async (exportId, { storageKey, fileName, recordCount, expiresAt }) =>
  AuditExport.findOneAndUpdate(
    { exportId },
    {
      status: 'completed',
      storageKey,
      fileName,
      recordCount,
      expiresAt,
      completedAt: new Date(),
      error: null,
    },
    { new: true },
  ).lean();

/** Fail a row, recording the reason. */
export const markFailed = async (exportId, error) =>
  AuditExport.findOneAndUpdate(
    { exportId },
    { status: 'failed', error: String(error ?? '').slice(0, 500), completedAt: new Date() },
    { new: true },
  ).lean();

/** Paginated export-request listing (admin surface). */
export const list = async ({ filter = {}, page = 1, limit = 20 } = {}) => {
  const result = await AuditExport.paginate(filter, {
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

/** Hard-delete export rows (and their metadata) past `before`. */
export const deleteExpired = async ({ before }) =>
  AuditExport.deleteMany({ expiresAt: { $lt: before } });

export default {
  create,
  findByExportId,
  findById,
  markProcessing,
  markCompleted,
  markFailed,
  list,
  deleteExpired,
  _meta: { lifecycle: ['queued', 'processing', 'completed', 'failed'] },
};
