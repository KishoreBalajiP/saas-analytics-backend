/**
 * Role (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   A role is a named collection of permission ids. Stored as data,
 *   never hardcoded. Permissions are derived from
 *   `${moduleKey}.${action}` keys.
 *
 * PLANNED FIELDS
 *   _id, tenantId | null,            // null = platform role
 *   name, description?,
 *   level: 'platform' | 'tenant',
 *   isSystem: boolean,               // platform-defined roles are immutable
 *   permissionIds: string[],         // refs to Permission._id
 *   createdAt, updatedAt, createdBy, updatedBy
 *
 * PLANNED INDEXES
 *   - { level: 1, name: 1 } unique
 *
 * RELATIONSHIPS
 *   - Role -> RolePermission[] -> Permission
 *   - Role -> AdminRole[] -> Admin
 *   - Role -> UserRole[] -> User
 */

export const MODEL_NAME = 'Role';
export const ROLE_LEVELS = Object.freeze(['platform', 'tenant']);

export default Object.freeze({
  name: MODEL_NAME,
  levels: ROLE_LEVELS,
  isSystemRolesProtected: true,
  schemaImplemented: false,
  seeAlso: ['src/modules/iam/roles/README.md'],
});
