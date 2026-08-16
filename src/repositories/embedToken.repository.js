/**
 * EmbedToken Repository (Sprint 9 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for persisted embed tokens
 *   (`models/EmbedToken.js`). Owns every read/write against the
 *   EmbedToken collection. The plaintext token never exists here — only
 *   `tokenHash` is stored and indexed.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - list, findById, findByTokenHash, create, update, softDelete,
 *     countActiveByDashboard.
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Tenant scoping is explicit (`tenantId: { $eq }`) plus the
 *     `tenantScope` plugin as a second line of defence.
 *   - `findByTokenHash` is deliberately unscoped: hashes are globally
 *     unique, and the service verifies tenancy/liveness after lookup.
 */

import { EmbedToken } from '../models/EmbedToken.js';

/** Paginated token list for a tenant, optionally scoped to a dashboard. */
export const list = async ({ tenantId, dashboardId, filter = {}, page = 1, limit = 20 } = {}) => {
  const query = { tenantId, ...(dashboardId ? { dashboardId } : {}), ...filter };
  const result = await EmbedToken.paginate(query, {
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

/** Find a token by id within a tenant. */
export const findById = (id, { tenantId } = {}) =>
  EmbedToken.findOne({ _id: id, ...(tenantId ? { tenantId } : {}) }).lean();

/** Find a token by its SHA-256 hash (global, unique). */
export const findByTokenHash = (tokenHash) => EmbedToken.findOne({ tokenHash }).lean();

/** Create a token. Returns the saved plain document. */
export const create = async (data) => {
  const doc = new EmbedToken(data);
  await doc.save();
  return doc.toObject();
};

/** Apply a patch to a token. Returns the updated lean doc or null. */
export const update = (id, patch) =>
  EmbedToken.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

/** Soft-delete a token. Returns the plain doc or null. */
export const remove = async (id, by) => {
  const doc = await EmbedToken.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/** Count non-expired, active tokens for a dashboard (for caps). */
export const countActiveByDashboard = async (dashboardId) =>
  EmbedToken.countDocuments({ dashboardId, status: 'active', expiresAt: { $gt: new Date() } });

export default {
  list,
  findById,
  findByTokenHash,
  create,
  update,
  remove,
  countActiveByDashboard,
  _meta: { leanReturns: true, tenancy: 'tenant', secrets: 'sha256-hashed only' },
};