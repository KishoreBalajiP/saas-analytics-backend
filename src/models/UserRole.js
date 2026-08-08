/**
 * UserRole (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Join row: which role a tenant user has. Carries optional scope and
 *   expiry for temporary or narrowly-scoped grants.
 *
 * DESIGN CONSTRAINTS
 *   - A user may hold a role once per scope. The unique index covers the
 *     scoped grant fully: an unscoped grant is (t, u, r, null, null) and
 *     a scoped grant differs by (resourceType, resourceId).
 *   - `expiresAt` powers a Mongo TTL index: expired grants are removed
 *     automatically. The service layer also filters them out on read so
 *     a lagging TTL never grants access.
 *   - `tenantScope` plugin applies (defence in depth on tenant-owned
 *     authorisation data).
 *
 * PLUGINS
 *   tenantScope, softDelete, paginate, optimisticConcurrency, audit
 *   (module `iam.roles`).
 *
 * INDEXES
 *   - unique({ tenantId, userId, roleId, scope.resourceType, scope.resourceId })
 *   - TTL on expiresAt (expireAfterSeconds: 0)
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'UserRole';

const userRoleSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    roleId: { type: String, required: true, index: true },
    scope: {
      resourceType: { type: String, default: null },
      resourceId: { type: String, default: null },
    },
    grantedBy: { type: String, default: null },
    grantedAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userRoleSchema.index(
  {
    tenantId: 1,
    userId: 1,
    roleId: 1,
    'scope.resourceType': 1,
    'scope.resourceId': 1,
  },
  { unique: true },
);

// Auto-remove temporary grants once they lapse.
userRoleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

userRoleSchema.plugin(tenantScope);
userRoleSchema.plugin(softDelete);
userRoleSchema.plugin(paginate);
userRoleSchema.plugin(optimisticConcurrency);
userRoleSchema.plugin(audit, { module: 'iam.roles' });

export const UserRoleSchema = userRoleSchema;
export const UserRole = mongoose.model(MODEL_NAME, userRoleSchema);
export default UserRole;
