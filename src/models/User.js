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
 *   - unique(tenantId, email)
 *   - { status: 1, lastLoginAt: -1 }
 *   - unique sparse { ssoProvider: 1, ssoSubject: 1 }
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'User';
export const USER_STATUSES = Object.freeze(['invited', 'active', 'suspended', 'locked']);
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
  },
  { timestamps: true },
);

// Email is unique within a tenant, not globally.
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });
// Common list/filter path.
userSchema.index({ status: 1, lastLoginAt: -1 });
// Lookup of SSO-linked users; sparse so password-only users are omitted.
userSchema.index({ ssoProvider: 1, ssoSubject: 1 }, { unique: true, sparse: true });

userSchema.plugin(tenantScope);
userSchema.plugin(softDelete);
userSchema.plugin(paginate);
userSchema.plugin(optimisticConcurrency);
userSchema.plugin(audit, { module: 'iam.users' });

export const UserSchema = userSchema;
export const User = mongoose.model(MODEL_NAME, userSchema);
export default User;
