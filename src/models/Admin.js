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
 *   - `failedAttempts` + `lockedUntil` persist account lockout state.
 *   - `tenantScope` is the optional tenant a `support` admin may operate
 *     in. It is NOT multi-tenancy scoping (admins are platform-scoped),
 *     which is why the `tenantScope` plugin is not applied here.
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
export const ADMIN_TYPES = Object.freeze(['super', 'platform', 'support']);
export const ADMIN_STATUSES = Object.freeze(['pending', 'active', 'suspended', 'locked']);

const adminSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    mfaSecret: { type: String, default: null },
    mfaEnabled: { type: Boolean, default: false },
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
