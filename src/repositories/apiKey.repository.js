/**
 * ApiKey Repository (Sprint 9 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for persisted API keys
 *   (`models/ApiKey.js`). Owns every read/write against the ApiKey
 *   collection. The full secret never exists here — only `prefix` +
 *   `secretHash` are stored and indexed.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - list, findById, findByPrefix, create, update, softDelete, countByStatus.
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Tenant scoping is explicit (`tenantId: { $eq }`) plus the
 *     `tenantScope` plugin as a second line of defence.
 *   - `findByPrefix` is deliberately unscoped: prefixes are globally unique
 *     (sparse unique index), so the lookup precedes tenancy verification in
 *     the service.
 */

import { ApiKey } from '../models/ApiKey.js';

/** Paginated key list for a tenant, optionally filtered by status. */
export const list = async ({ tenantId, filter = {}, page = 1, limit = 20 } = {}) => {
  const query = { tenantId, ...filter };
  const result = await ApiKey.paginate(query, {
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

/** Find a key by id within a tenant. */
export const findById = (id, { tenantId } = {}) =>
  ApiKey.findOne({ _id: id, ...(tenantId ? { tenantId } : {}) }).lean();

/** Find a key by its public prefix (global, unique). */
export const findByPrefix = (prefix) => ApiKey.findOne({ prefix }).lean();

/** Create a key. Returns the saved plain document. */
export const create = async (data) => {
  const doc = new ApiKey(data);
  await doc.save();
  return doc.toObject();
};

/** Apply a patch to a key. Returns the updated lean doc or null. */
export const update = (id, patch) =>
  ApiKey.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

/** Soft-delete a key. Returns the plain doc or null. */
export const remove = async (id, by) => {
  const doc = await ApiKey.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/** Count keys by status within a tenant (for per-tenant caps). */
export const countByStatus = async ({ tenantId, status } = {}) =>
  ApiKey.countDocuments({ tenantId, status });

export default {
  list,
  findById,
  findByPrefix,
  create,
  update,
  remove,
  countByStatus,
  _meta: { leanReturns: true, tenancy: 'tenant', secrets: 'sha256-hashed only' },
};