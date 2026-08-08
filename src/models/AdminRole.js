/**
 * AdminRole (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Join row: which role a Platform Admin has. Mirrors UserRole but
 *   scopes to platform (`tenantId === null`) or to a single support
 *   tenant (a `support` admin operating inside one tenant).
 *
 * DESIGN CONSTRAINTS
 *   - Unique (adminId, roleId, tenantId): an admin may hold a role once
 *     at platform scope and again per support tenant.
 *   - `expiresAt` powers a Mongo TTL index for temporary grants; the
 *     service layer also filters expired grants on read.
 *   - Admins are platform identities, so the `tenantScope` plugin is
 *     intentionally NOT applied.
 *
 * PLUGINS
 *   softDelete, paginate, optimisticConcurrency, audit (module `iam.roles`).
 *
 * INDEXES
 *   - unique({ adminId: 1, roleId: 1, tenantId: 1 })
 *   - TTL on expiresAt (expireAfterSeconds: 0)
 */

import mongoose from 'mongoose';
import { softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'AdminRole';

const adminRoleSchema = new mongoose.Schema(
  {
    adminId: { type: String, required: true, index: true },
    tenantId: { type: String, default: null, index: true },
    roleId: { type: String, required: true, index: true },
    grantedBy: { type: String, default: null },
    grantedAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

adminRoleSchema.index({ adminId: 1, roleId: 1, tenantId: 1 }, { unique: true });

// Auto-remove temporary grants once they lapse.
adminRoleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

adminRoleSchema.plugin(softDelete);
adminRoleSchema.plugin(paginate);
adminRoleSchema.plugin(optimisticConcurrency);
adminRoleSchema.plugin(audit, { module: 'iam.roles' });

export const AdminRoleSchema = adminRoleSchema;
export const AdminRole = mongoose.model(MODEL_NAME, adminRoleSchema);
export default AdminRole;
