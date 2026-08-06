/**
 * Admin Repository (Sprint 1 - auth surface implemented).
 *
 * PURPOSE
 *   Stable data-access surface for Platform Admins. Sprint 1 implements the
 *   auth surface; the CRUD surface stays fail-closed until Sprint 2.
 *
 * RESPONSIBILITY (implemented, Sprint 1 auth)
 *   - findById, findByEmail, findByEmailForAuth
 *   - update, incrementFailedAttempts, resetFailedAttempts, setLockedUntil,
 *     touchLastLogin, updateMfa
 *
 * RESPONSIBILITY (planned, still stubbed for Sprint 2)
 *   - list, create, suspend, restore, listRolesForAdmin, assignRole, revokeRole
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
import { notImplementedStub } from '../utils/stubs.js';

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

// --- Sprint 2 CRUD surface (stubbed, fail-closed) -------------------------
export const list = notImplementedStub('admin.repository', 'list');
export const create = notImplementedStub('admin.repository', 'create');
export const suspend = notImplementedStub('admin.repository', 'suspend');
export const restore = notImplementedStub('admin.repository', 'restore');
export const listRolesForAdmin = notImplementedStub('admin.repository', 'listRolesForAdmin');
export const assignRole = notImplementedStub('admin.repository', 'assignRole');
export const revokeRole = notImplementedStub('admin.repository', 'revokeRole');

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
  _meta: { leanReturns: true, tenancy: 'platform', stubbed: ['list', 'create', 'suspend', 'restore', 'listRolesForAdmin', 'assignRole', 'revokeRole'] },
};
