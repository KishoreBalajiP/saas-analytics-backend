/**
 * UserRole (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Join row: which role a tenant user has. Carries optional scope and
 *   expiry for temporary or narrowly-scoped grants.
 *
 * PLANNED FIELDS
 *   _id, tenantId, userId (ref), roleId (ref),
 *   scope?: { resourceType, resourceId },
 *   grantedBy, grantedAt, expiresAt?
 *
 * PLANNED INDEXES
 *   - { userId: 1, roleId: 1 } unique(tenantId, userId, roleId, scope?)
 *   - TTL on expiresAt (planned)
 */

export const MODEL_NAME = 'UserRole';

export default Object.freeze({
  name: MODEL_NAME,
  supportsScope: true,
  supportsExpiry: true,
  schemaImplemented: false,
  seeAlso: ['src/modules/iam/roles/README.md'],
});
