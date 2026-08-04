/**
 * User (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Tenant end-user identity. Distinct from `Admin`. Logs in to the
 *   Tenant Portal, Mobile App, Embed widget and via Public APIs.
 *
 * PLANNED FIELDS
 *   _id, tenantId, email (unique within tenant), passwordHash | null,
 *   ssoProvider?: 'google'|'microsoft'|'saml', ssoSubject?,
 *   status: 'invited' | 'active' | 'suspended' | 'locked',
 *   profile: { name, locale, timezone, avatarUrl, phone? },
 *   lastLoginAt, failedAttempts, lockedUntil,
 *   invitedBy, acceptedAt,
 *   createdAt, updatedAt
 *
 * PLANNED INDEXES
 *   - unique(tenantId, email)
 *   - { status: 1, lastLoginAt: -1 }
 *
 * RELATIONSHIPS
 *   - User -> UserRole[] -> Role -> Permission[]
 */

export const MODEL_NAME = 'User';
export const USER_STATUSES = Object.freeze([
  'invited', 'active', 'suspended', 'locked',
]);
export const SSO_PROVIDERS = Object.freeze([
  'google', 'microsoft', 'saml',
]);

export default Object.freeze({
  name: MODEL_NAME,
  statuses: USER_STATUSES,
  ssoProviders: SSO_PROVIDERS,
  emailUniqueness: 'per-tenant',
  schemaImplemented: false,
  seeAlso: ['src/modules/iam/users/README.md'],
});
