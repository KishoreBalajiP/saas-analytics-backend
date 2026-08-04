/**
 * AdminRole (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Join row: which role a Platform Admin has. Mirrors UserRole but
 *   scopes to platform (tenantId == null) or to a single support tenant.
 *
 * PLANNED FIELDS
 *   _id, adminId (ref), tenantId | null,
 *   roleId (ref),
 *   grantedBy, grantedAt, expiresAt?
 *
 * PLANNED INDEXES
 *   - { adminId: 1, roleId: 1 } unique when tenantId == null
 *   - TTL on expiresAt (planned)
 */

export const MODEL_NAME = 'AdminRole';

export default Object.freeze({
  name: MODEL_NAME,
  supportsExpiry: true,
  schemaImplemented: false,
  seeAlso: ['src/models/UserRole.js'],
});
