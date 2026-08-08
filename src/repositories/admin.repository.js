/**
 * Admin Repository (Sprint 1 - auth surface implemented).
 *
 * PURPOSE
 *   Stable data-access surface for Platform Admins. Sprint 1 implements the
 *   auth surface; the CRUD surface stays fail-closed until Sprint 2.
 *
 * RESPONSIBILITY (implemented)
 *   - findById, findByEmail, findByEmailForAuth
 *   - update, incrementFailedAttempts, resetFailedAttempts, setLockedUntil,
 *     touchLastLogin, updateMfa
 *   - list, create, suspend, restore
 *   - listRolesForAdmin, assignRole, revokeRole
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Admins are PLATFORM-scoped: no tenantId on queries. `tenantScope` is
 *     an admin's optional escalation scope, not multi-tenancy scoping.
 *   - Lockout counters are updated with atomic `$inc`.
 *   - `updateMfa` enforces the invariant `mfaEnabled === false` whenever
 *     `mfaSecret` is absent so the two fields cannot drift.
 */

import { Admin } from '../models/Admin.js';
import { AdminRole } from '../models/AdminRole.js';
import { Role } from '../models/Role.js';

/** Fields required by the admin login path. */
const AUTH_PROJECTION =
  'email status adminType tenantScope profile.name failedAttempts lockedUntil passwordHash mfaEnabled mfaSecret lastLoginAt';

/** Find an admin by id. Returns a lean object or null. */
export const findById = (id) => Admin.findById(id).lean();

/** Find an admin by email (globally unique). */
export const findByEmail = (email) => Admin.findOne({ email: email.toLowerCase() }).lean();

/** Login-path lookup with an explicit projection. */
export const findByEmailForAuth = (email) =>
  Admin.findOne({ email: email.toLowerCase() })
    .select(AUTH_PROJECTION)
    .lean();

/** Apply a patch to an admin, optionally recording the actor. */
export const update = (id, patch, { by } = {}) =>
  Admin.findByIdAndUpdate(
    id,
    { $set: { ...patch, ...(by ? { updatedBy: by } : {}) } },
    { new: true, runValidators: true, lean: true },
  );

/** Atomically bump the failed-attempt counter. */
export const incrementFailedAttempts = (id) =>
  Admin.findByIdAndUpdate(id, { $inc: { failedAttempts: 1 } }, { new: true, lean: true });

/** Clear the lockout state after a successful login. */
export const resetFailedAttempts = (id) =>
  Admin.findByIdAndUpdate(
    id,
    { $set: { failedAttempts: 0, lockedUntil: null } },
    { new: true, lean: true },
  );

/** Persist the lockout deadline. `until` is a Date or null. */
export const setLockedUntil = (id, until) =>
  Admin.findByIdAndUpdate(id, { $set: { lockedUntil: until } }, { new: true, lean: true });

/** Record a successful login timestamp. */
export const touchLastLogin = (id) =>
  Admin.findByIdAndUpdate(id, { $set: { lastLoginAt: new Date() } }, { new: true, lean: true });

/**
 * Persist MFA state. `mfaEnabled` defaults to `Boolean(mfaSecret)` when
 * omitted; passing `mfaSecret: null` disables MFA in one call.
 */
export const updateMfa = (id, { mfaSecret = null, mfaEnabled } = {}) => {
  const enabled = mfaEnabled === undefined ? Boolean(mfaSecret) : mfaEnabled;
  return Admin.findByIdAndUpdate(
    id,
    { $set: { mfaSecret, mfaEnabled: Boolean(mfaSecret) && enabled } },
    { new: true, runValidators: true, lean: true },
  );
};

// --- Sprint 2 CRUD surface (implemented) ----------------------------------
/** Paginated admin list, filterable by status and/or adminType. */
export const list = async ({ filter = {}, page = 1, limit = 20 } = {}) => {
  const result = await Admin.paginate(filter, {
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

/** Create an admin. `data` must already carry the password hash. */
export const create = async (data) => {
  const doc = new Admin(data);
  await doc.save();
  return doc.toObject();
};

/** Suspend an admin (status -> `suspended`). Returns the updated doc. */
export const suspend = (id, by) =>
  Admin.findByIdAndUpdate(
    id,
    { $set: { status: 'suspended', updatedBy: by ?? null } },
    { new: true, runValidators: true, lean: true },
  );

/** Restore a suspended admin (status -> `active`). Returns the updated doc. */
export const restore = (id, by) =>
  Admin.findByIdAndUpdate(
    id,
    { $set: { status: 'active', updatedBy: by ?? null } },
    { new: true, runValidators: true, lean: true },
  );

/** List every role grant for an admin, joined with the Role row. */
export const listRolesForAdmin = async (adminId) => {
  const grants = await AdminRole.find({ adminId }).lean();
  if (grants.length === 0) return [];
  const roleIds = [...new Set(grants.map((g) => g.roleId))];
  const roles = await Role.find({ _id: { $in: roleIds } }).lean();
  const byId = new Map(roles.map((r) => [r._id.toString(), r]));
  return grants
    .map((g) => {
      const role = byId.get(g.roleId.toString());
      return role
        ? {
            roleId: g.roleId,
            role: { name: role.name, level: role.level, isSystem: role.isSystem },
            tenantId: g.tenantId,
            grantedBy: g.grantedBy,
            grantedAt: g.grantedAt,
            expiresAt: g.expiresAt,
          }
        : null;
    })
    .filter(Boolean);
};

/**
 * Grant a role to an admin (platform when `tenantId` is null, or scoped
 * to a support tenant). Returns the new grant row, or `null` when the
 * (adminId, roleId, tenantId) triple already exists.
 */
export const assignRole = async (adminId, roleId, { by = null, tenantId = null, expiresAt = null } = {}) => {
  try {
    const doc = new AdminRole({ adminId, roleId, tenantId, grantedBy: by, expiresAt });
    await doc.save();
    return doc.toObject();
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
};

/** Revoke a role grant. Returns the number of rows removed. */
export const revokeRole = (adminId, roleId, { tenantId = null } = {}) =>
  AdminRole.deleteOne({ adminId, roleId, tenantId }).then((r) => r.deletedCount);

export default {
  findById,
  findByEmail,
  findByEmailForAuth,
  update,
  incrementFailedAttempts,
  resetFailedAttempts,
  setLockedUntil,
  touchLastLogin,
  updateMfa,
  list,
  create,
  suspend,
  restore,
  listRolesForAdmin,
  assignRole,
  revokeRole,
  _meta: { leanReturns: true, tenancy: 'platform' },
};
