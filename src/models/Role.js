/**
 * Role (Sprint 2 - implemented).
 *
 * PURPOSE
 *   A role is a named collection of permissions. Stored as data, never
 *   hardcoded. Permissions are derived from `key` (`module.action`)
 *   strings via the `RolePermission` join table.
 *
 * DESIGN CONSTRAINTS
 *   - `tenantId === null` means a platform-level role; a non-null value
 *     means a tenant-level role. The two are mutually exclusive and
 *     enforced at the schema level.
 *   - `isSystem` roles (the seed) are immutable - enforced in the
 *     service layer, not here.
 *   - The Sprint-0 plan's `permissionIds: string[]` field is realised as
 *     `RolePermission` join rows so membership never mutates a Role doc.
 *
 * INDEXES
 *   - unique sparse({ tenantId: 1, name: 1 }) - a role name is unique per
 *     scope (platform or tenant). This supersedes the earlier
 *     `{ level, name }` plan because `{ level, name }` would collide
 *     across tenants (two tenants may both define a role named `analyst`).
 *   - { level: 1 }
 *   - { isSystem: 1 }
 *
 * PLUGINS
 *   softDelete, paginate, optimisticConcurrency, audit (module `iam.roles`).
 *
 * RELATIONSHIPS
 *   - Role -> RolePermission[] -> Permission
 *   - Role -> AdminRole[] -> Admin
 *   - Role -> UserRole[] -> User
 */

import mongoose from 'mongoose';
import { softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Role';
export const ROLE_LEVELS = Object.freeze(['platform', 'tenant']);

const roleSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: null, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    level: { type: String, enum: [...ROLE_LEVELS], default: 'tenant', index: true },
    isSystem: { type: Boolean, default: false, index: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

// A role name is unique per scope (platform or tenant), never global.
roleSchema.index({ tenantId: 1, name: 1 }, { unique: true, sparse: true });

// Level and tenantId are two views of the same fact; keep them in sync.
roleSchema.pre('validate', function validateRoleScope(next) {
  if (this.level === 'platform' && this.tenantId != null) {
    return next(new Error('platform roles must have a null tenantId'));
  }
  if (this.level === 'tenant' && !this.tenantId) {
    return next(new Error('tenant roles require a tenantId'));
  }
  next();
});

roleSchema.plugin(softDelete);
roleSchema.plugin(paginate);
roleSchema.plugin(optimisticConcurrency);
roleSchema.plugin(audit, { module: 'iam.roles' });

export const RoleSchema = roleSchema;
export const Role = mongoose.model(MODEL_NAME, roleSchema);
export default Role;
