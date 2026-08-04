/**
 * Module (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   A logical capability area in the platform (e.g. `iam`,
 *   `analytics`). Permissions and roles group under a module. Modules
 *   are registered at runtime via `/permissions/modules`.
 *
 * PLANNED FIELDS
 *   _id, key (unique), name, description?,
 *   parentKey?: string,              // planned hierarchy
 *   createdAt, updatedAt
 *
 * PLANNED INDEXES
 *   - unique(key)
 */

export const MODEL_NAME = 'Module';
export const BUILTIN_MODULES = Object.freeze([
  'iam', 'platform', 'governance',
  'analytics', 'connectors', 'tenants',
  'users', 'roles', 'settings',
  'feature_flags', 'master_data',
  'monitoring', 'notifications',
  'email_templates', 'audit_logs',
  'access_logs', 'compliance', 'support',
]);

export default Object.freeze({
  name: MODEL_NAME,
  builtinKeys: BUILTIN_MODULES,
  hierarchySupported: true,
  schemaImplemented: false,
  seeAlso: ['src/modules/iam/permissions/README.md'],
});
