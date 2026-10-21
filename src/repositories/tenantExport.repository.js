/**
 * TenantExport Repository (roadmap 2.9).
 *
 * PURPOSE
 *   Data access for tenant data export rows (`models/TenantExport.js`).
 *
 * CODING GUIDELINES
 *   - Every tenant-facing read requires `tenantId` and throws without it, so
 *     a missing scope can never widen a lookup to every tenant.
 *   - Status transitions are conditional updates (`findOneAndUpdate` with the
 *     expected source state), so a retried or redelivered job can never
 *     double-advance a row, and a late finish never overwrites `expired`.
 *   - Reads return PLAIN objects (`.lean()`).
 */

import { TenantExport } from '../models/TenantExport.js';

const ACTIVE = ['queued', 'processing'];

function requireTenant(tenantId) {
  if (tenantId === undefined || tenantId === null || String(tenantId).length === 0) {
    throw new Error('tenantExport.repository: tenantId is required');
  }
  return String(tenantId);
}

/**
 * Create a queued row. A second in-flight export for the same tenant fails
 * with a duplicate-key error (code 11000) from the partial unique index.
 */
export const create = async (data) => {
  const doc = new TenantExport({ ...data, status: 'queued', inFlight: true });
  await doc.save();
  return doc.toObject();
};

/** Find an export by its public id within one tenant. */
export const findForTenant = (tenantId, exportId) =>
  TenantExport.findOne({ tenantId: requireTenant(tenantId), exportId: String(exportId) }).lean();

/** Find an export by its public id (worker side, no tenant context yet). */
export const findByExportId = (exportId) => TenantExport.findOne({ exportId: String(exportId) }).lean();

/** The tenant's in-flight export, if any. */
export const findInFlight = (tenantId) =>
  TenantExport.findOne({ tenantId: requireTenant(tenantId), inFlight: true }).lean();

/** Paginated listing for one tenant, newest first. */
export const listForTenant = async (tenantId, { page = 1, limit = 20 } = {}) => {
  const result = await TenantExport.paginate(
    { tenantId: requireTenant(tenantId) },
    { page, limit, lean: true, sort: { createdAt: -1 } },
  );
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Exports a tenant requested itself since `since` (daily limit). */
export const countRequestedSince = (tenantId, { since, origin = 'tenant' }) =>
  TenantExport.countDocuments({ tenantId: requireTenant(tenantId), origin, createdAt: { $gte: since } });

/**
 * Claim a row for processing: a queued row, or a processing row whose lease
 * expired (its worker died and the job was redelivered).
 */
export const claim = ({ exportId, now = new Date(), leaseMs, maxAttempts }) =>
  TenantExport.findOneAndUpdate(
    {
      exportId: String(exportId),
      attempts: { $lt: maxAttempts },
      $or: [{ status: 'queued' }, { status: 'processing', leaseUntil: { $lte: now } }],
    },
    {
      $set: { status: 'processing', startedAt: now, leaseUntil: new Date(now.getTime() + leaseMs) },
      $inc: { attempts: 1 },
    },
    { new: true, lean: true },
  );

/** Extend the processing lease (heartbeat). */
export const renewLease = ({ exportId, leaseUntil }) =>
  TenantExport.updateOne({ exportId: String(exportId), status: 'processing' }, { $set: { leaseUntil } });

/** Complete a processing row with the artefact metadata. */
export const markCompleted = ({ exportId, now = new Date(), fields }) =>
  TenantExport.findOneAndUpdate(
    { exportId: String(exportId), status: 'processing' },
    {
      $set: { ...fields, status: 'completed', completedAt: now, leaseUntil: null, error: null },
      $unset: { inFlight: 1 },
    },
    { new: true, lean: true },
  );

/** Fail a queued/processing row with a sanitised error. */
export const markFailed = ({ exportId, now = new Date(), error }) =>
  TenantExport.findOneAndUpdate(
    { exportId: String(exportId), status: { $in: ACTIVE } },
    {
      $set: { status: 'failed', completedAt: now, leaseUntil: null, error },
      $unset: { inFlight: 1 },
    },
    { new: true, lean: true },
  );

/** Completed exports whose artefact expired before `now` (bounded batch). */
export const findExpired = ({ now = new Date(), limit = 100 } = {}) =>
  TenantExport.find({ status: 'completed', expiresAt: { $lte: now } })
    .sort({ expiresAt: 1 })
    .limit(limit)
    .lean();

/** Mark a completed export expired (artefact deleted). */
export const markExpired = ({ exportId, now = new Date() }) =>
  TenantExport.findOneAndUpdate(
    { exportId: String(exportId), status: 'completed' },
    { $set: { status: 'expired', expiredAt: now }, $unset: { storageKey: 1 } },
    { new: true, lean: true },
  );

/** Queued/processing rows whose lease ran out (bounded batch). */
export const findAbandoned = ({ now = new Date(), limit = 100 } = {}) =>
  TenantExport.find({ status: { $in: ACTIVE }, leaseUntil: { $lte: now } }).limit(limit).lean();

export default {
  create,
  findForTenant,
  findByExportId,
  findInFlight,
  listForTenant,
  countRequestedSince,
  claim,
  renewLease,
  markCompleted,
  markFailed,
  findExpired,
  markExpired,
  findAbandoned,
};
