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

/** Resolve either the canonical id or the public workspace slug. */
export const findByIdOrSlug = async (identifier) => {
  try {
    const byId = await findById(identifier);
    if (byId) return byId;
  } catch (err) {
    if (err?.name !== 'CastError') throw err;
  }
  return findBySlug(identifier);
};

/** Create a tenant. Returns the saved plain document. */
export const create = async (data) => {
  const doc = new Tenant(data);
  await doc.save();
  return doc.toObject();
};

/** Apply a patch to a tenant. `slug` is immutable and ignored by Mongoose. */
export const update = (id, patch) =>
  Tenant.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

/** Complete initialization only while the tenant remains pending/active. */
export const completeInitialization = (id, patch) =>
  Tenant.findOneAndUpdate(
    { _id: id, status: { $in: ['pending', 'active'] } },
    { $set: patch },
    { new: true, runValidators: true, lean: true },
  );

/** Remove a registration tenant only while it is still an untouched draft. */
export const deleteUninitialized = (id) =>
  Tenant.findOneAndDelete({
    _id: id,
    status: 'pending',
    onboardingStatus: 'not_started',
    ownerId: null,
  });

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

// members: ownership and deletion writes (roadmap 2.10).

/**
 * Point `ownerId` at a new owner only while it still holds the value the
 * caller read (compare-and-set), so two concurrent transfers cannot both win.
 * Returns the updated tenant, or null when `ownerId` changed meanwhile.
 */
export const compareAndSetOwner = (id, { expected = null, next, by = null }) =>
  Tenant.findOneAndUpdate(
    { _id: id, ownerId: expected ?? null },
    { $set: { ownerId: next ? String(next) : null, updatedBy: by } },
    { new: true, runValidators: true, lean: true },
  );

/**
 * Close a workspace for deletion: `active` -> `disabled` with the deletion
 * reason. Only matches an active tenant. Returns the updated doc or null.
 */
export const disableForDeletion = (id, { by = null, reason = null } = {}) =>
  Tenant.findOneAndUpdate(
    { _id: id, status: 'active' },
    { $set: { status: 'disabled', disabledAt: new Date(), disabledReason: reason, updatedBy: by } },
    { new: true, runValidators: true, lean: true },
  );

/** Archived tenants archived before `before` (purge scheduling). */
export const listArchivedBefore = ({ before, limit = 100 }) =>
  Tenant.find({ status: 'archived', archivedAt: { $ne: null, $lte: before } })
    .sort({ archivedAt: 1 })
    .limit(limit)
    .select('_id slug name status archivedAt')
    .lean();

/** Count tenants in a status (used by statistics / platform dashboard). */
export const countByStatus = (status) => Tenant.countDocuments({ status });

/** Escape regex metacharacters so user input can be a safe `$regex`. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  findById,
  findBySlug,
  findByIdOrSlug,
  create,
  update,
  completeInitialization,
  deleteUninitialized,
  list,
  suspend,
  restore,
  disable,
  archive,
  countByStatus,
  compareAndSetOwner,
  disableForDeletion,
  listArchivedBefore,
  _meta: { leanReturns: true, tenancy: 'platform', immutable: ['slug'] },
};
