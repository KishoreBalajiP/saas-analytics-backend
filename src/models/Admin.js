/**
 * Admin (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Platform Admin identity. NOT a tenant user. Owns the platform's
 *   configuration, support tooling and high-privilege operations.
 *
 * SECURITY
 *   - `passwordHash` stores the Argon2id hash (see `utils/password.js`).
 *   - `mfaSecret` is the encrypted TOTP secret (Sprint 0 encryption util);
 *     `mfaEnabled` gates whether MFA is enforced at login.
 *   - `mfaRecoveryCodes` holds digests of unused recovery codes only
 *     (`select: false`); `passwordHash` is null for invited admins.
 *   - `failedAttempts` + `lockedUntil` persist account lockout state.
 *   - `tenantScope` is the optional tenant the admin is confined to. When
 *     set, every platform route that reads or acts on tenant data only
 *     reaches that tenant (`middleware/adminScope.middleware.js`), and
 *     platform-wide routes refuse the admin. It is NOT multi-tenancy
 *     scoping of this collection, which is why the `tenantScope` plugin is
 *     not applied here.
 *   - `adminType` is the privilege ceiling (super > platform > support >
 *     auditor): built-in platform roles above it cannot be granted, and an
 *     `auditor` is refused every non-read permission
 *     (`constants/platformRoles.js`).
 *
 * PLUGINS
 *   softDelete, paginate, optimisticConcurrency, audit (module `iam.admins`).
 *
 * INDEXES
 *   - unique(email)
 *   - { status: 1, lastLoginAt: -1 }
 *   - { adminType: 1 }
 */

import mongoose from 'mongoose';
import { softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Admin';
// Ordered from most to least privileged; `auditor` is read-only (roadmap 2.1).
export const ADMIN_TYPES = Object.freeze(['super', 'platform', 'support', 'auditor']);
export const ADMIN_STATUSES = Object.freeze(['pending', 'active', 'suspended', 'locked']);

const adminSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // adminauth: null until an invited admin accepts the invitation (and
    // after an admin-assisted password reset); login never passes without it.
    passwordHash: { type: String, default: null },
    mfaSecret: { type: String, default: null },
    mfaEnabled: { type: Boolean, default: false },
    // adminauth: SHA-256 digests of the UNUSED one-time recovery codes
    // (`utils/recoveryCodes.js`). A used code's digest is pulled atomically.
    // Never selected by default, so admin reads and audit snapshots never
    // carry them.
    mfaRecoveryCodes: { type: [String], default: [], select: false },
    mfaRecoveryCodesGeneratedAt: { type: Date, default: null },
    // adminauth: set by an admin-assisted MFA reset; forces enrolment at the
    // next sign-in whatever the admin type.
    mfaEnrollmentRequired: { type: Boolean, default: false },
    status: { type: String, enum: [...ADMIN_STATUSES], default: 'pending', index: true },
    adminType: { type: String, enum: [...ADMIN_TYPES], default: 'platform' },
    tenantScope: { type: String, default: null },
    profile: {
      name: { type: String, trim: true, default: '' },
      locale: { type: String, default: 'en' },
      timezone: { type: String, default: 'UTC' },
      avatarUrl: { type: String, default: null },
    },
    lastLoginAt: { type: Date, default: null },
    failedAttempts: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

adminSchema.index({ status: 1, lastLoginAt: -1 });
adminSchema.index({ adminType: 1 });

adminSchema.plugin(softDelete);
adminSchema.plugin(paginate);
adminSchema.plugin(optimisticConcurrency);
adminSchema.plugin(audit, { module: 'iam.admins' });

export const AdminSchema = adminSchema;
export const Admin = mongoose.model(MODEL_NAME, adminSchema);
export default Admin;
