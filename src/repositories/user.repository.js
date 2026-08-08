/**
 * User Repository (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for tenant end-users. Owns every read and
 *   write the auth module needs against `models/User.js`.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - findById, findByEmail, findByEmailForAuth
 *   - update, incrementFailedAttempts, resetFailedAttempts, setLockedUntil,
 *     touchLastLogin
 *   - create, suspend, restore
 *   - softDelete, list (paginated)
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`); services handle data, not
 *     Mongoose documents.
 *   - Every tenant-scoped query filters by `tenantId` explicitly - this is
 *     the primary line of defence (the `tenantScope` plugin is the second).
 *   - Lockout counters are updated with atomic `$inc` so concurrent failed
 *     logins cannot clobber each other (Sprint 1 risk 5: persistence).
 *   - NO business logic: the service decides policy (when to lock, when to
 *     clear); this file only persists and fetches.
 */

import { User } from '../models/User.js';

/** Fields required by the login path. Avoids pulling the full profile. */
const AUTH_PROJECTION = 'email status tenantId profile.name failedAttempts lockedUntil passwordHash lastLoginAt';

/** Find a user by id. Returns a lean object or null. */
export const findById = (id) => User.findById(id).lean();

/** Find a user by email within a tenant. Tenant scoping is mandatory. */
export const findByEmail = (tenantId, email) =>
  User.findOne({ tenantId, email: email.toLowerCase() }).lean();

/** Login-path lookup: same as findByEmail, but with an explicit projection. */
export const findByEmailForAuth = (tenantId, email) =>
  User.findOne({ tenantId, email: email.toLowerCase() })
    .select(AUTH_PROJECTION)
    .lean();

/** Apply a patch to a user. `patch` keys must be schema paths. */
export const update = (id, patch) =>
  User.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

/** Atomically bump the failed-attempt counter. Returns the updated user. */
export const incrementFailedAttempts = (id) =>
  User.findByIdAndUpdate(id, { $inc: { failedAttempts: 1 } }, { new: true, lean: true });

/** Clear the lockout state after a successful login. */
export const resetFailedAttempts = (id) =>
  User.findByIdAndUpdate(
    id,
    { $set: { failedAttempts: 0, lockedUntil: null } },
    { new: true, lean: true },
  );

/** Persist the lockout deadline. `until` is a Date or null. */
export const setLockedUntil = (id, until) =>
  User.findByIdAndUpdate(id, { $set: { lockedUntil: until } }, { new: true, lean: true });

/** Record a successful login timestamp. */
export const touchLastLogin = (id) =>
  User.findByIdAndUpdate(id, { $set: { lastLoginAt: new Date() } }, { new: true, lean: true });

/** Soft-delete a user, recording the actor. Returns the plain doc or null. */
export const softDelete = async (id, by) => {
  const doc = await User.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/**
 * Create a user (e.g. via invitation). `data` must carry `tenantId` and
 * `email`; the service decides initial status and password hash.
 */
export const create = async (data) => {
  const doc = new User(data);
  await doc.save();
  return doc.toObject();
};

/** Suspend a user inside a tenant. Returns the updated doc or null. */
export const suspend = (id, tenantId, by) =>
  User.findOneAndUpdate(
    { _id: id, tenantId },
    { $set: { status: 'suspended', updatedBy: by ?? null } },
    { new: true, runValidators: true, lean: true },
  );

/** Restore a suspended user inside a tenant. Returns the updated doc or null. */
export const restore = (id, tenantId, by) =>
  User.findOneAndUpdate(
    { _id: id, tenantId },
    { $set: { status: 'active', updatedBy: by ?? null } },
    { new: true, runValidators: true, lean: true },
  );

/** Count non-deleted users in a tenant (used by tenant statistics). */
export const countByTenant = (tenantId) => User.countDocuments({ tenantId });

/** Paginated tenant-scoped list. `filter` is merged with the tenant scope. */
export const list = async ({ tenantId, filter = {}, page = 1, limit = 20 } = {}) => {
  const result = await User.paginate(
    { ...filter, tenantId },
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

export default {
  findById,
  findByEmail,
  findByEmailForAuth,
  update,
  incrementFailedAttempts,
  resetFailedAttempts,
  setLockedUntil,
  touchLastLogin,
  softDelete,
  list,
  create,
  suspend,
  restore,
  countByTenant,
  _meta: { leanReturns: true, tenancy: 'tenant', lockout: 'atomic-persisted' },
};
