/**
 * Dashboard Repository (Sprint 6 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for persisted dashboards
 *   (`models/Dashboard.js`). Owns every read/write against the Dashboard
 *   collection, including the `shares` sub-array mutations.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - list, findById, create, update, softDelete
 *   - addShare, removeShare
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Tenant scoping is explicit (`tenantId: { $eq }`) plus the
 *     `tenantScope` plugin as a second line of defence.
 *   - `layout`/`filters`/`refresh` are Mixed fields validated by the
 *     service layer, never by the repository.
 */

import { Dashboard } from '../models/Dashboard.js';

/** Paginated dashboard list for a tenant, optionally filtered by status/search. */
export const list = async ({ tenantId, filter = {}, page = 1, limit = 20 } = {}) => {
  const query = { tenantId, ...filter };
  const result = await Dashboard.paginate(query, {
    page,
    limit,
    lean: true,
    sort: { updatedAt: -1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Find a dashboard by id within a tenant. */
export const findById = (id, { tenantId } = {}) =>
  Dashboard.findOne({ _id: id, ...(tenantId ? { tenantId } : {}) }).lean();

/** Create a dashboard. Returns the saved plain document. */
export const create = async (data) => {
  const doc = new Dashboard(data);
  await doc.save();
  return doc.toObject();
};

/** Apply a patch to a dashboard. Returns the updated lean doc or null. */
export const update = (id, patch) =>
  Dashboard.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

/** Soft-delete a dashboard. Returns the plain doc or null. */
export const remove = async (id, by) => {
  const doc = await Dashboard.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/** Add a share grant to a dashboard's `shares` sub-array. */
export const addShare = async (id, share) => {
  const doc = await Dashboard.findByIdAndUpdate(
    id,
    { $push: { shares: share } },
    { new: true, runValidators: true, lean: true },
  );
  return doc;
};

/** Remove a share grant (matched by its sub-document _id) from a dashboard. */
export const removeShare = async (id, shareId) => {
  const doc = await Dashboard.findByIdAndUpdate(
    id,
    { $pull: { shares: { _id: shareId } } },
    { new: true, runValidators: true, lean: true },
  );
  return doc;
};

export default {
  list,
  findById,
  create,
  update,
  remove,
  addShare,
  removeShare,
  _meta: { leanReturns: true, tenancy: 'tenant' },
};
