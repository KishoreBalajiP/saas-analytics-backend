/**
 * Tenant Deletion Repository (roadmap 2.10).
 *
 * PURPOSE
 *   Data access for `TenantDeletion` records: create the open record,
 *   cancel it, claim due purges atomically (with a lease, so two workers
 *   never purge the same tenant at once), and record the outcome.
 *
 * CODING GUIDELINES
 *   - Database access only; the lifecycle and purge services decide policy.
 *   - Claims are single conditional `findOneAndUpdate` calls.
 *   - Lean returns.
 */

import { TenantDeletion } from '../models/TenantDeletion.js';

/** Create a deletion record. A second open record for a tenant throws E11000. */
export const create = async (data) => (await TenantDeletion.create({ ...data, open: true })).toObject();

export const findById = (id) => TenantDeletion.findById(id).lean();

/** The tenant's open (scheduled, purging or failed) deletion, if any. */
export const findOpenByTenant = (tenantId) =>
  TenantDeletion.findOne({ tenantId: String(tenantId), open: true }).lean();

/** The tenant's most recent deletion record (any status). */
export const findLatestByTenant = (tenantId) =>
  TenantDeletion.findOne({ tenantId: String(tenantId) }).sort({ createdAt: -1 }).lean();

/** Cancel a scheduled deletion. Returns the updated record, or null when it is no longer scheduled. */
export const cancel = (id, { by, reason = null, now = new Date() }) =>
  TenantDeletion.findOneAndUpdate(
    { _id: id, status: 'scheduled' },
    { $set: { status: 'cancelled', open: false, cancelledAt: now, cancelledBy: by, cancelReason: reason } },
    { new: true, lean: true },
  );

/**
 * Claim one due purge: a scheduled record past its grace period, a failed one
 * still under the attempt limit whose backoff elapsed, or a purging one whose
 * lease lapsed (its worker died). Returns the claimed record or null.
 */
export const claimDue = ({ now = new Date(), leaseMs, maxAttempts }) =>
  TenantDeletion.findOneAndUpdate(
    {
      attempts: { $lt: maxAttempts },
      purgeAfter: { $lte: now },
      $or: [
        { status: 'scheduled' },
        { status: 'failed', $or: [{ retryAfter: null }, { retryAfter: { $lte: now } }] },
        { status: 'purging', leaseUntil: { $lt: now } },
      ],
    },
    {
      $set: { status: 'purging', leaseUntil: new Date(now.getTime() + leaseMs), startedAt: now },
      $inc: { attempts: 1 },
    },
    { new: true, lean: true, sort: { purgeAfter: 1 } },
  );

/** Record a finished purge (verified). */
export const markPurged = (id, { verification, now = new Date() }) =>
  TenantDeletion.findOneAndUpdate(
    { _id: id, status: 'purging' },
    {
      $set: {
        status: 'purged', open: false, purgedAt: now, leaseUntil: null, verification,
        lastError: { code: null, message: null },
      },
    },
    { new: true, lean: true },
  );

/**
 * Record a failed attempt. It is retried by a later run (not before
 * `retryAfter`) while attempts remain.
 */
export const markFailed = (id, { error, verification = null, retryAfter = null }) =>
  TenantDeletion.findOneAndUpdate(
    { _id: id, status: 'purging' },
    {
      $set: {
        status: 'failed', leaseUntil: null, retryAfter, lastError: error, ...(verification ? { verification } : {}),
      },
    },
    { new: true, lean: true },
  );

/** Paginated listing for the platform admin view. */
export const list = async ({ status, tenantId, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (tenantId) filter.tenantId = String(tenantId);
  const result = await TenantDeletion.paginate(filter, { page, limit, lean: true, sort: { createdAt: -1 } });
  return { docs: result.docs, total: result.totalDocs, page: result.page, limit: result.limit, pages: result.totalPages };
};

export default {
  create,
  findById,
  findOpenByTenant,
  findLatestByTenant,
  cancel,
  claimDue,
  markPurged,
  markFailed,
  list,
  _meta: { leanReturns: true, tenancy: 'platform-evidence' },
};
