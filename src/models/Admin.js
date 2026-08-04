/**
 * Admin (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Platform Admin identity. NOT a tenant user. Owns the platform's
 *   configuration, support tooling and high-privilege operations.
 *
 * PLANNED FIELDS (Phase 2 schemas land here)
 *   _id, email (unique, lower), passwordHash, mfaSecret?, mfaEnabled,
 *   status: 'pending' | 'active' | 'suspended' | 'locked',
 *   adminType: 'super' | 'platform' | 'support',
 *   tenantScope?: tenantId | null,   // only for support admins
 *   profile: { name, locale, timezone, avatarUrl },
 *   lastLoginAt, failedAttempts, lockedUntil,
 *   createdAt, updatedAt, createdBy, updatedBy
 *
 * PLANNED INDEXES
 *   - unique(email)
 *   - { status: 1, lastLoginAt: -1 }
 *
 * RELATIONSHIPS
 *   - Admin -> AdminRole[] (many-to-many, with optional tenant scope)
 *   - AdminRole -> Role -> Permission[]
 *
 * WHY NO SCHEMA HERE
 *   Phase 1.2 establishes the module surface. Schemas land in Phase 2 along
 *   with auth, hashing, and RBAC. Do NOT add mongoose.Schema here.
 */

export const MODEL_NAME = 'Admin';
export const ADMIN_TYPES = Object.freeze(['super', 'platform', 'support']);
export const ADMIN_STATUSES = Object.freeze(['pending', 'active', 'suspended', 'locked']);

export default Object.freeze({
  name: MODEL_NAME,
  types: ADMIN_TYPES,
  statuses: ADMIN_STATUSES,
  schemaImplemented: false,
  seeAlso: [
    'src/services/admin.service.js',
    'src/repositories/admin.repository.js',
    'src/modules/iam/admins/README.md',
  ],
});
