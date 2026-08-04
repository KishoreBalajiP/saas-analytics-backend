/**
 * Permission (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Atomic authorisation: a (module, action) pair. The runtime check is
 *   `actor has permissionId on resource`. Permissions are data, not code.
 *
 * PLANNED FIELDS
 *   _id, moduleId (ref), action: string,
 *   key: string,                     // composed as `${moduleKey}.${action}`
 *   description?, isSystem: boolean,
 *   createdAt, updatedAt
 *
 * PLANNED INDEXES
 *   - unique(key)
 *   - { moduleId: 1, action: 1 } unique
 */

export const MODEL_NAME = 'Permission';
export const CANONICAL_ACTIONS = Object.freeze([
  'view', 'create', 'update', 'delete', 'export',
  'approve', 'suspend', 'restore', 'assign', 'configure',
]);

export default Object.freeze({
  name: MODEL_NAME,
  canonicalActions: CANONICAL_ACTIONS,
  keyShape: 'module_key.action',
  schemaImplemented: false,
  seeAlso: ['src/modules/iam/permissions/README.md'],
});
