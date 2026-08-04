/**
 * RolePermission (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Join row: which permission a role has. Permission assignment NEVER
 *   mutates the Permission document - it only adds/removes join rows.
 *
 * PLANNED FIELDS
 *   _id, roleId (ref), permissionId (ref),
 *   grantedBy, grantedAt
 *
 * PLANNED INDEXES
 *   - unique(roleId, permissionId)
 */

export const MODEL_NAME = 'RolePermission';

export default Object.freeze({
  name: MODEL_NAME,
  unique: ['roleId', 'permissionId'],
  schemaImplemented: false,
  seeAlso: [
    'src/models/Role.js',
    'src/models/Permission.js',
    'src/services/role.service.js',
  ],
});
