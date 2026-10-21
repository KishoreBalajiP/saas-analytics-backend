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
 *     touchLastLogin, updateMfa, clearExpiredLockout
 *   - list, create, suspend, restore
 *   - listRolesForAdmin, assignRole, revokeRole
 *   - countActiveSupers, updateIfMatch (compare-and-set),
 *     countActiveSupersHoldingRoles, listGrantsForAdmin
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
  'email status adminType tenantScope profile.name failedAttempts lockedUntil passwordHash mfaEnabled mfaSecret lastLoginAt mfaEnrollmentRequired';

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

/**
 * Clear a lockout whose window has passed (`lockedUntil <= now`) and reset
 * the counter, atomically. Only matches while the expired deadline is still
 * stored, so of several concurrent failures exactly one resets, and a
 * lockout that is in force is never cleared. Returns the updated admin, or
 * null when nothing matched.
 */
export const clearExpiredLockout = (id, now = new Date()) =>
  Admin.findOneAndUpdate(
    { _id: id, lockedUntil: { $ne: null, $lte: now } },
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
  const on = Boolean(mfaSecret) && enabled;
  return Admin.findByIdAndUpdate(
    id,
    {
      $set: {
        mfaSecret,
        mfaEnabled: on,
        // adminauth: recovery codes only exist while MFA is on.
        ...(on ? {} : { mfaRecoveryCodes: [], mfaRecoveryCodesGeneratedAt: null }),
      },
    },
    { new: true, runValidators: true, lean: true },
  );
};

/* ---------------------- adminauth: MFA recovery + invites ---------------------- */

/**
 * Turn MFA on with a fresh set of recovery-code digests, but only while the
 * enrolment it confirms is still pending (MFA off, same stored secret), so
 * two concurrent confirmations cannot both issue codes. Clears the
 * admin-assisted "must re-enrol" flag. Returns the updated admin or null.
 */
export const enableMfa = (id, { mfaSecret, recoveryCodeHashes }) =>
  Admin.findOneAndUpdate(
    { _id: id, mfaEnabled: false, mfaSecret },
    {
      $set: {
        mfaEnabled: true,
        mfaRecoveryCodes: recoveryCodeHashes,
        mfaRecoveryCodesGeneratedAt: new Date(),
        mfaEnrollmentRequired: false,
      },
    },
    { new: true, runValidators: true, lean: true },
  );

/**
 * Replace the recovery-code digests of an admin whose MFA is on. The
 * returned document leaves the digests out (`select: false`), so the audit
 * plugin's snapshot of this update never carries them.
 */
export const replaceRecoveryCodes = (id, recoveryCodeHashes) =>
  Admin.findOneAndUpdate(
    { _id: id, mfaEnabled: true },
    { $set: { mfaRecoveryCodes: recoveryCodeHashes, mfaRecoveryCodesGeneratedAt: new Date() } },
    { new: true, runValidators: true, lean: true },
  );

/** MFA state including the (normally unselected) recovery-code digests. */
export const findMfaState = (id) =>
  Admin.findById(id)
    .select('mfaEnabled mfaSecret mfaRecoveryCodes mfaRecoveryCodesGeneratedAt mfaEnrollmentRequired status adminType')
    .lean();

/**
 * Atomically remove one used recovery-code digest. Matches only while MFA is
 * on and the digest is still present, so a code can be used exactly once
 * even under concurrent requests. Returns true when this call spent it.
 * (`updateOne`, not `findOneAndUpdate`: the audit plugin would otherwise
 * snapshot the remaining digests; the caller emits a security event.)
 */
export const consumeRecoveryCode = async (id, digest) => {
  const res = await Admin.updateOne(
    { _id: id, mfaEnabled: true, mfaRecoveryCodes: digest, deletedAt: null },
    { $pull: { mfaRecoveryCodes: digest } },
  );
  return res.modifiedCount === 1;
};

/**
 * Admin-assisted MFA reset: wipe the secret and recovery codes and require
 * enrolment at the next sign-in.
 */
export const resetMfa = (id, { by } = {}) =>
  Admin.findByIdAndUpdate(
    id,
    {
      $set: {
        mfaSecret: null,
        mfaEnabled: false,
        mfaRecoveryCodes: [],
        mfaRecoveryCodesGeneratedAt: null,
        mfaEnrollmentRequired: true,
        ...(by ? { updatedBy: by } : {}),
      },
    },
    { new: true, runValidators: true, lean: true },
  );

/**
 * Activate an invited admin: set the password and status `active`, only
 * while the admin is still `pending`. Returns the updated admin or null.
 */
export const activateInvited = (id, { passwordHash, name }) =>
  Admin.findOneAndUpdate(
    { _id: id, status: 'pending' },
    {
      $set: {
        passwordHash,
        status: 'active',
        failedAttempts: 0,
        lockedUntil: null,
        ...(name ? { 'profile.name': name } : {}),
      },
    },
    { new: true, runValidators: true, lean: true },
  );

/**
 * Remove a never-activated (pending, passwordless) admin and its role
 * grants, e.g. when the invitation is revoked. Returns the deleted count.
 */
export const deletePending = async (id) => {
  const res = await Admin.deleteOne({ _id: id, status: 'pending', passwordHash: null });
  if (res.deletedCount > 0) await AdminRole.deleteMany({ adminId: String(id) });
  return res.deletedCount;
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

/** Count currently-active super admins. Used to enforce the last-super rule. */
export const countActiveSupers = () =>
  Admin.countDocuments({ adminType: 'super', status: 'active' });

/**
 * Compare-and-set: apply `set` only while the admin still matches `match`
 * (e.g. `{ adminType: 'super', status: 'active' }`). Returns the updated doc,
 * or null when the admin no longer matches (changed concurrently).
 */
export const updateIfMatch = (id, match, set, { by } = {}) =>
  Admin.findOneAndUpdate(
    { _id: id, ...match },
    { $set: { ...set, ...(by ? { updatedBy: by } : {}) } },
    { new: true, runValidators: true, lean: true },
  );

/**
 * Count active super admins holding a live platform grant of any role in
 * `roleIds` (the super-admin roles). Used so the last such grant cannot be
 * revoked.
 */
export const countActiveSupersHoldingRoles = async (roleIds = []) => {
  if (roleIds.length === 0) return 0;
  const live = { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] };
  const adminIds = await AdminRole.distinct('adminId', {
    roleId: { $in: roleIds.map(String) },
    tenantId: null,
    ...live,
  });
  if (adminIds.length === 0) return 0;
  return Admin.countDocuments({ _id: { $in: adminIds }, adminType: 'super', status: 'active' });
};

/** Every live grant (platform and scoped) of an admin, raw. */
export const listGrantsForAdmin = (adminId) => AdminRole.find({ adminId: String(adminId) }).lean();

export default {
  findById,
  findByEmail,
  findByEmailForAuth,
  update,
  incrementFailedAttempts,
  resetFailedAttempts,
  clearExpiredLockout,
  setLockedUntil,
  touchLastLogin,
  updateMfa,
  enableMfa,
  replaceRecoveryCodes,
  findMfaState,
  consumeRecoveryCode,
  resetMfa,
  activateInvited,
  deletePending,
  list,
  create,
  suspend,
  restore,
  listRolesForAdmin,
  assignRole,
  revokeRole,
  countActiveSupers,
  updateIfMatch,
  countActiveSupersHoldingRoles,
  listGrantsForAdmin,
  _meta: { leanReturns: true, tenancy: 'platform' },
};
