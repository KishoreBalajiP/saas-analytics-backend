/**
 * User (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Tenant end-user identity. Distinct from `Admin`. Logs in to the
 *   Tenant Portal, Mobile App, Embed widget and via Public APIs.
 *
 * SECURITY
 *   - `passwordHash` stores the Argon2id hash (see `utils/password.js`).
 *     Plain-text passwords NEVER touch the database.
 *   - `failedAttempts` + `lockedUntil` persist the account-lockout state
 *     so lockouts survive instance restarts (Sprint 1 risk 5).
 *   - `passwordHash` is `null` for SSO-only users.
 *   - mfa-tenant: `mfaSecret` is the TOTP secret ENCRYPTED with
 *     `utils/encryption.js` (per-user context); `mfaRecoveryCodes` holds
 *     SHA-256 digests of the unused recovery codes; `mfaLastTimeStep` is the
 *     last accepted TOTP time step (a code is accepted once). All three are
 *     `select: false`, so no list or profile read ever carries them.
 *
 * MULTI-TENANCY
 *   - `tenantScope` plugin enforces `tenantId` on reads/writes.
 *   - Email uniqueness is PER-TENANT (compound unique index), never global.
 *
 * PLUGINS
 *   tenantScope, softDelete, paginate, optimisticConcurrency, audit
 *   (module `iam.users`).
 *
 * INDEXES
 *   - unique partial (tenantId, email) over live rows (`deletedAt: null`), so
 *     a removed member's email can be invited again (roadmap 2.10, db.07)
 *   - { status: 1, lastLoginAt: -1 }
 *   - unique partial { ssoProvider: 1, ssoSubject: 1 } (live SSO rows only)
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'User';
export const USER_STATUSES = Object.freeze(['invited', 'unverified', 'active', 'suspended', 'locked']);
export const SSO_PROVIDERS = Object.freeze(['google', 'microsoft', 'saml']);

const userSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, default: null },
    ssoProvider: { type: String, enum: [...SSO_PROVIDERS], default: null },
    ssoSubject: { type: String, default: null },
    status: { type: String, enum: [...USER_STATUSES], default: 'invited', index: true },
    profile: {
      name: { type: String, trim: true, default: '' },
      locale: { type: String, default: 'en' },
      timezone: { type: String, default: 'UTC' },
      avatarUrl: { type: String, default: null },
      phone: { type: String, default: null },
    },
    lastLoginAt: { type: Date, default: null },
    failedAttempts: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    invitedBy: { type: String, default: null },
    acceptedAt: { type: Date, default: null },
    // onboarding: legal consent recorded at self-service registration.
    consent: {
      termsVersion: { type: String, default: null },
      acceptedAt: { type: Date, default: null },
      ip: { type: String, default: null },
    },
    // rls: tenant-defined user attributes used by row-level security rules
    // (`{ region: 'EU', teams: ['a', 'b'] }`). Values are strings or string
    // arrays; set only through `PUT /data-access/users/:userId/attributes`.
    attributes: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    // mfa-tenant: tenant-user TOTP MFA (mirrors the admin design).
    mfaSecret: { type: String, default: null, select: false },
    mfaEnabled: { type: Boolean, default: false },
    mfaRecoveryCodes: { type: [String], default: [], select: false },
    mfaRecoveryCodesGeneratedAt: { type: Date, default: null },
    mfaLastTimeStep: { type: Number, default: null, select: false },
    mfaEnrollmentExpiresAt: { type: Date, default: null, select: false },
    // Set by an Owner-assisted reset: enrolment is required at the next
    // sign-in even when the workspace policy does not require MFA.
    mfaEnrollmentRequired: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Email is unique within a tenant, not globally, and only among live rows:
// a soft-deleted (removed) member must not block re-inviting the address.
userSchema.index(
  { tenantId: 1, email: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
// Common list/filter path.
userSchema.index({ status: 1, lastLoginAt: -1 });
// Lookup of SSO-linked users. A PARTIAL index, not a plain sparse index:
// Mongoose writes `default: null` for password-only users, and sparse
// indexes only skip documents where the field is *missing* - a `null`
// value is still indexed, so two password users would collide on the
// unique key. The partial filter restricts the index to live SSO rows only.
userSchema.index(
  { ssoProvider: 1, ssoSubject: 1 },
  { unique: true, partialFilterExpression: { ssoSubject: { $type: 'string' }, deletedAt: null } },
);

userSchema.plugin(tenantScope);
userSchema.plugin(softDelete);
userSchema.plugin(paginate);
userSchema.plugin(optimisticConcurrency);
userSchema.plugin(audit, { module: 'iam.users' });

export const UserSchema = userSchema;
export const User = mongoose.model(MODEL_NAME, userSchema);
export default User;
