/**
 * Setting Repository (Sprint 3 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for hot-reloadable, typed, scoped settings
 *   (`models/Setting.js`). Owns every read/write against the Setting
 *   collection for the tenant-settings surface.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - list, findById, findByKey, create, update, upsertByKey, softDelete
 *   - `coerceValue(type, value)` - the value-shape guarantee; typed values
 *     always come back shaped to `type`.
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Tenant rows are filtered by `tenantId` explicitly (the `tenantScope`
 *     plugin is a second line of defence, with `optional: true` so
 *     platform rows with a null `tenantId` stay legal).
 *   - `upsertByKey` is the idempotent write the onboarding initialiser
 *     uses: re-running it never creates duplicates (unique index on
 *     `{ scope, tenantId, key }`).
 *   - `isSecret` handling lives in the service (privilege is policy, not
 *     persistence).
 */

import ApiError from '../utils/ApiError.js';
import { Setting } from '../models/Setting.js';

/**
 * Coerce a raw value into the shape declared by `type`. Used on write
 * (validate before persist) and on read (guarantee the wire shape).
 *
 * @param {'string'|'number'|'boolean'|'json'|'duration'} type
 * @param {*} value
 * @returns {*}
 */
export function coerceValue(type, value) {
  switch (type) {
    case 'string':
      return value == null ? '' : String(value);
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw ApiError.badRequest('Setting value must be a finite number');
      return n;
    }
    case 'duration': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        throw ApiError.badRequest('Duration setting must be a non-negative number of milliseconds');
      }
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      throw ApiError.badRequest('Setting value must be a boolean');
    case 'json': {
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          throw ApiError.badRequest('JSON setting value must be valid JSON');
        }
      }
      return value;
    }
    default:
      throw ApiError.badRequest(`Unknown setting type "${type}"`);
  }
}

/** List settings in a scope, optionally narrowed by group. Lean docs. */
export const list = async ({ scope, tenantId = null, group, page = 1, limit = 100 } = {}) => {
  const filter = { scope, tenantId };
  if (group) filter.group = group;
  const result = await Setting.paginate(filter, {
    page,
    limit,
    lean: true,
    sort: { group: 1, key: 1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Find a setting by id. Returns a lean object or null. */
export const findById = (id) => Setting.findById(id).lean();

/** Find a setting by its scoped key. Returns a lean object or null. */
export const findByKey = ({ key, scope, tenantId = null }) =>
  Setting.findOne({ key, scope, tenantId }).lean();

/** Find many settings by keys within one scope (used for bulk resolution). */
export const findByKeys = ({ keys, scope, tenantId = null }) =>
  Setting.find({ key: { $in: keys }, scope, tenantId }).lean();

/** Create a setting row. `value` is coerced to `type` before persist. */
export const create = async (data) => {
  const doc = new Setting({ ...data, value: coerceValue(data.type, data.value) });
  await doc.save();
  return doc.toObject();
};

/** Apply a patch to a setting. Returns the updated lean doc or null. */
export const update = (id, patch) => {
  const set = { ...patch };
  if (patch.type !== undefined && patch.value !== undefined) {
    set.value = coerceValue(patch.type, patch.value);
  } else if (patch.value !== undefined) {
    set.value = patch.value;
  }
  return Setting.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: true, lean: true });
};

/**
 * Idempotent scoped upsert by key (used by the onboarding initialiser).
 * Returns `{ setting, created: boolean }`.
 */
export const upsertByKey = async ({ key, scope, tenantId = null, type, value, description = '', isSecret = false, isReadonly = false, group = 'general', updatedBy = null }) => {
  const existing = await findByKey({ key, scope, tenantId });
  if (existing) {
    const patch = {};
    if (type !== undefined) patch.type = type;
    if (value !== undefined) patch.value = value;
    if (description !== undefined) patch.description = description;
    if (isSecret !== undefined) patch.isSecret = isSecret;
    if (isReadonly !== undefined) patch.isReadonly = isReadonly;
    if (group !== undefined) patch.group = group;
    patch.updatedBy = updatedBy ?? existing.updatedBy ?? null;
    const updated = await update(existing._id, patch);
    return { setting: updated, created: false };
  }
  const setting = await create({
    key, scope, tenantId, type, value, description, isSecret, isReadonly, group, updatedBy,
  });
  return { setting, created: true };
};

/** Soft-delete a setting row. Returns the plain doc or null. */
export const softDelete = async (id, by) => {
  const doc = await Setting.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

export default {
  list,
  findById,
  findByKey,
  findByKeys,
  create,
  update,
  upsertByKey,
  softDelete,
  coerceValue,
  _meta: { leanReturns: true, tenancy: 'platform+tenant', unique: 'scope+tenantId+key' },
};
