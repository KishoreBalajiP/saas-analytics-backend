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
 *     touchLastLogin, clearExpiredLockout
 *   - create, suspend, restore
 *   - softDelete, list (paginated)
 *   - mfa-tenant: findMfaState, startMfaEnrollment, enableMfa,
 *     disableMfa, replaceRecoveryCodes, consumeRecoveryCode,
 *     markTotpStepUsed, resetMfa, listMfaStatus
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
const AUTH_PROJECTION = 'email status tenantId profile.name failedAttempts lockedUntil passwordHash lastLoginAt'
  // mfa-tenant: the login path decides on the second factor from these.
  + ' mfaEnabled mfaEnrollmentRequired';

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

/**
 * Clear a lockout whose window has passed (`lockedUntil <= now`) and reset
 * the counter, atomically. Only matches while the expired deadline is still
 * stored, so of several concurrent failures exactly one resets, and a
 * lockout that is in force (e.g. set moments ago) is never cleared.
 * Returns the updated user, or null when nothing matched.
 */
export const clearExpiredLockout = (id, now = new Date()) =>
  User.findOneAndUpdate(
    { _id: id, lockedUntil: { $ne: null, $lte: now } },
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

/**
 * Hard-delete a user. Reserved for registration rollback of a freshly
 * created account whose workspace never finished provisioning - normal
 * deletions must go through `softDelete`.
 */
export const hardDelete = (id) => User.findByIdAndDelete(id);

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

/* ------------------------- mfa-tenant: MFA state ------------------------- */

/** Fields an MFA decision needs, including the `select: false` secrets. */
const MFA_PROJECTION = '+mfaSecret +mfaRecoveryCodes +mfaLastTimeStep '
  + 'tenantId email status passwordHash failedAttempts mfaEnabled mfaRecoveryCodesGeneratedAt mfaEnrollmentExpiresAt mfaEnrollmentRequired';

/**
 * MFA state of a user, including the encrypted secret and the recovery-code
 * digests. When `tenantId` is given the user must belong to it.
 */
export const findMfaState = (id, tenantId = null) =>
  User.findOne({ _id: id, ...(tenantId ? { tenantId } : {}) }).select(MFA_PROJECTION).lean();

/**
 * Store a pending enrolment secret (MFA stays off). Only while MFA is off,
 * so a started enrolment can never silently replace an active secret.
 * Returns the updated user (without the secret) or null.
 */
export const startMfaEnrollment = (id, mfaSecret, expiresAt) =>
  User.findOneAndUpdate(
    { _id: id, mfaEnabled: { $ne: true } },
    { $set: { mfaSecret, mfaEnabled: false, mfaRecoveryCodes: [], mfaRecoveryCodesGeneratedAt: null, mfaLastTimeStep: null, mfaEnrollmentExpiresAt: expiresAt } },
    { new: true, runValidators: true, lean: true },
  );

/** Clear only the matching pending enrolment after its expiry. */
export const clearExpiredMfaEnrollment = (id, mfaSecret, now = new Date()) =>
  User.updateOne(
    {
      _id: id,
      mfaEnabled: { $ne: true },
      mfaSecret,
      $or: [{ mfaEnrollmentExpiresAt: null }, { mfaEnrollmentExpiresAt: { $lte: now } }],
    },
    { $set: { mfaSecret: null, mfaEnrollmentExpiresAt: null, mfaLastTimeStep: null } },
  );

/**
 * Turn MFA on with fresh recovery-code digests, but only while the enrolment
 * it confirms is still pending (MFA off, same stored secret), so two
 * concurrent confirmations cannot both issue codes. Records the time step of
 * the confirming code and clears the Owner-reset flag.
 */
export const enableMfa = (id, { mfaSecret, recoveryCodeHashes, timeStep = null }) =>
  User.findOneAndUpdate(
    { _id: id, mfaEnabled: { $ne: true }, mfaSecret, mfaEnrollmentExpiresAt: { $gt: new Date() } },
    {
      $set: {
        mfaEnabled: true,
        mfaRecoveryCodes: recoveryCodeHashes,
        mfaRecoveryCodesGeneratedAt: new Date(),
        mfaLastTimeStep: timeStep,
        mfaEnrollmentExpiresAt: null,
        mfaEnrollmentRequired: false,
      },
    },
    { new: true, runValidators: true, lean: true },
  );

/** Turn MFA off: wipe the secret, the recovery codes and the replay marker. */
export const disableMfa = (id) =>
  User.findOneAndUpdate(
    { _id: id, mfaEnabled: true },
    { $set: { mfaSecret: null, mfaEnabled: false, mfaRecoveryCodes: [], mfaRecoveryCodesGeneratedAt: null,     mfaLastTimeStep: null, mfaEnrollmentExpiresAt: null } },
    { new: true, runValidators: true, lean: true },
  );

/** Replace the recovery-code digests of a user whose MFA is on. */
export const replaceRecoveryCodes = (id, recoveryCodeHashes) =>
  User.findOneAndUpdate(
    { _id: id, mfaEnabled: true },
    { $set: { mfaRecoveryCodes: recoveryCodeHashes, mfaRecoveryCodesGeneratedAt: new Date() } },
    { new: true, runValidators: true, lean: true },
  );

/**
 * Atomically remove one used recovery-code digest. Matches only while MFA is
 * on and the digest is still present, so a code works exactly once even
 * under concurrent requests. Returns true when this call spent it.
 */
export const consumeRecoveryCode = async (id, digest) => {
  const res = await User.updateOne(
    { _id: id, mfaEnabled: true, mfaRecoveryCodes: digest, deletedAt: null },
    { $pull: { mfaRecoveryCodes: digest } },
  );
  return res.modifiedCount === 1;
};

/**
 * Record that a TOTP time step was used, only when it is newer than the last
 * accepted one (atomic), so the same code cannot be replayed within its
 * validity window. Returns true when this call recorded it.
 */
export const markTotpStepUsed = async (id, timeStep) => {
  const res = await User.updateOne(
    {
      _id: id,
      mfaEnabled: true,
      $or: [{ mfaLastTimeStep: null }, { mfaLastTimeStep: { $lt: timeStep } }],
    },
    { $set: { mfaLastTimeStep: timeStep } },
  );
  return res.modifiedCount === 1;
};

/**
 * Owner-assisted reset: wipe the secret and recovery codes and require
 * enrolment at the next sign-in. Tenant-scoped.
 */
export const resetMfa = (id, tenantId, { by } = {}) =>
  User.findOneAndUpdate(
    { _id: id, tenantId },
    {
      $set: {
        mfaSecret: null,
        mfaEnabled: false,
        mfaRecoveryCodes: [],
        mfaRecoveryCodesGeneratedAt: null,
        mfaLastTimeStep: null,
        mfaEnrollmentExpiresAt: null,
        mfaEnrollmentRequired: true,
        ...(by ? { updatedBy: by } : {}),
      },
    },
    { new: true, runValidators: true, lean: true },
  );

/** MFA status of every member of a tenant (never the secrets). */
export const listMfaStatus = (tenantId, { limit = 500 } = {}) =>
  User.find({ tenantId })
    .select('email status profile.name mfaEnabled mfaEnrollmentRequired mfaRecoveryCodesGeneratedAt lastLoginAt')
    .sort({ email: 1 })
    .limit(limit)
    .lean();

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
  softDelete,
  hardDelete,
  list,
  create,
  suspend,
  restore,
  countByTenant,
  // mfa-tenant
  findMfaState,
  startMfaEnrollment,
  clearExpiredMfaEnrollment,
  enableMfa,
  disableMfa,
  replaceRecoveryCodes,
  consumeRecoveryCode,
  markTotpStepUsed,
  resetMfa,
  listMfaStatus,
  _meta: { leanReturns: true, tenancy: 'tenant', lockout: 'atomic-persisted' },
};
