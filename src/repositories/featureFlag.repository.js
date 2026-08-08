/**
 * FeatureFlag Repository (Sprint 3 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for the platform-wide feature flag
 *   catalogue (`models/FeatureFlag.js`). Owns every read/write against
 *   the FeatureFlag collection.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - list, findById, findByKey, create, update, softDelete
 *   - `findEnabled` - bulk fetch for the resolution cache. Rollout
 *     *evaluation* (percentage bucketing, tenant-allowlist, attribute
 *     rules) lives in `services/featureFlag.service.js`; persistence is
 *     deliberately kept dumb so the hot path stays reviewable.
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Flags are platform-global (no tenantId), so no tenant scoping is
 *     applied.
 *   - `softDelete` keeps the catalogue auditable; a deleted flag resolves
 *     to its `defaultValue` for everyone (the service treats it as off).
 */

import { FeatureFlag } from '../models/FeatureFlag.js';

/** Paginated catalogue listing. `filter` may contain `enabled` / `key`. */
export const list = async ({ filter = {}, page = 1, limit = 20 } = {}) => {
  const query = { ...filter };
  if (query.key) {
    query.key = { $regex: escapeRegExp(String(query.key)), $options: 'i' };
  }
  const result = await FeatureFlag.paginate(query, {
    page,
    limit,
    lean: true,
    sort: { key: 1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Find a flag by id. Returns a lean object or null. */
export const findById = (id) => FeatureFlag.findById(id).lean();

/** Find a flag by its unique key. Returns a lean object or null. */
export const findByKey = (key) => FeatureFlag.findOne({ key }).lean();

/** Fetch every enabled flag (used to seed the resolution cache). */
export const findEnabled = () => FeatureFlag.find({ enabled: true }).lean();

/** Create a flag. Returns the saved plain document. */
export const create = async (data) => {
  const doc = new FeatureFlag(data);
  await doc.save();
  return doc.toObject();
};

/** Apply a patch to a flag. Returns the updated lean doc or null. */
export const update = (id, patch) =>
  FeatureFlag.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

/** Soft-delete a flag. Returns the plain doc or null. */
export const softDelete = async (id, by) => {
  const doc = await FeatureFlag.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/** Escape regex metacharacters so user input can be a safe `$regex`. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  list,
  findById,
  findByKey,
  findEnabled,
  create,
  update,
  softDelete,
  _meta: { leanReturns: true, tenancy: 'platform', unique: 'key' },
};
