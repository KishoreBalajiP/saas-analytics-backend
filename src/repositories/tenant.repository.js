/**
 * Tenant Repository (Sprint 2 - implemented, Sprint 3 - extended).
 *
 * PURPOSE
 *   Stable data-access surface for the unit of multi-tenancy. Owns every
 *   read and write against `models/Tenant.js` for the `/tenants` API.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - findById, findBySlug, create, update, list
 *   - lifecycle transitions: suspend, restore, disable, archive
 *   - countByStatus (platform dashboard / statistics)
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Tenants are the tenancy unit itself, so there is NO tenantId
 *     scoping here; the service decides who may query which tenant.
 *   - `suspend`/`restore`/`disable`/`archive` are single atomic updates;
 *     the session cascade and audit/email side effects are the service's
 *     job (`services/tenantLifecycle.service.js`).
 */

import { Tenant } from '../models/Tenant.js';

/** Find a tenant by id. Returns a lean object or null. */
export const findById = (id) => Tenant.findById(id).lean();

/** Find a tenant by its unique slug. */
export const findBySlug = (slug) => Tenant.findOne({ slug: slug.toLowerCase() }).lean();

/** Create a tenant. Returns the saved plain document. */
export const create = async (data) => {
  const doc = new Tenant(data);
  await doc.save();
  return doc.toObject();
};

/** Apply a patch to a tenant. `slug` is immutable and ignored by Mongoose. */
export const update = (id, patch) =>
  Tenant.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

/**
 * Paginated tenant list (Platform Admin surface). `filter.search` performs
 * a case-insensitive name/slug substring match; every other filter key is
 * applied verbatim (e.g. `status`).
 */
export const list = async ({ filter = {}, page = 1, limit = 20 } = {}) => {
  const query = { ...filter };
  if (query.search) {
    const term = String(query.search).trim();
    query.$or = [
      { name: { $regex: escapeRegExp(term), $options: 'i' } },
      { slug: { $regex: escapeRegExp(term), $options: 'i' } },
    ];
  }
  delete query.search;
  const result = await Tenant.paginate(query, {
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

/** Suspend a tenant, recording who and why. Returns the updated doc. */
export const suspend = (id, { by = null, reason = null } = {}) =>
  Tenant.findByIdAndUpdate(
    id,
    {
      $set: {
        status: 'suspended',
        suspendedAt: new Date(),
        suspendedReason: reason ?? null,
        updatedBy: by,
      },
    },
    { new: true, runValidators: true, lean: true },
  );

/** Restore a suspended/disabled tenant (status -> `active`). */
export const restore = (id, { by = null, reason = null } = {}) =>
  Tenant.findByIdAndUpdate(
    id,
    {
      $set: {
        status: 'active',
        suspendedAt: null,
        suspendedReason: null,
        disabledAt: null,
        disabledReason: null,
        updatedBy: by,
      },
    },
    { new: true, runValidators: true, lean: true },
  );

/** Disable a tenant (longer-term block, reversible). */
export const disable = (id, { by = null, reason = null } = {}) =>
  Tenant.findByIdAndUpdate(
    id,
    {
      $set: {
        status: 'disabled',
        disabledAt: new Date(),
        disabledReason: reason ?? null,
        updatedBy: by,
      },
    },
    { new: true, runValidators: true, lean: true },
  );

/** Archive a tenant (terminal, read-only). */
export const archive = (id, { by = null, reason = null } = {}) =>
  Tenant.findByIdAndUpdate(
    id,
    {
      $set: {
        status: 'archived',
        archivedAt: new Date(),
        archivedReason: reason ?? null,
        updatedBy: by,
      },
    },
    { new: true, runValidators: true, lean: true },
  );

/** Count tenants in a status (used by statistics / platform dashboard). */
export const countByStatus = (status) => Tenant.countDocuments({ status });

/** Escape regex metacharacters so user input can be a safe `$regex`. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  findById,
  findBySlug,
  create,
  update,
  list,
  suspend,
  restore,
  disable,
  archive,
  countByStatus,
  _meta: { leanReturns: true, tenancy: 'platform', immutable: ['slug'] },
};
