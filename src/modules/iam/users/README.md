# IAM / users

Tenant Users: the humans who log in to the **Tenant Portal**, the
**Mobile App**, or interact with the **Embeddable Widget** / **Public APIs**
on behalf of a tenant.

They are NOT platform admins and have NO access to the Admin Portal's APIs.

## Planned endpoints

Most user-facing endpoints live under tenant-scoped routes (e.g.
`/api/v1/tenants/:tenantId/users`) and only Platform Admins can list
cross-tenant via `/api/v1/admin`.

- `GET    /tenants/:tenantId/users`
- `POST   /tenants/:tenantId/users`
- `GET    /tenants/:tenantId/users/:id`
- `PATCH  /tenants/:tenantId/users/:id`
- `POST   /tenants/:tenantId/users/:id/suspend`
- `POST   /tenants/:tenantId/users/:id/restore`
- `POST   /tenants/:tenantId/users/:id/roles`

## Data shape (architecture only)

`models/User.js` documents:

```
_id, tenantId, email (unique within tenant),
passwordHash (Argon2id) | null,         // null for SSO-only users
ssoProvider?: 'google' | 'microsoft' | 'saml',
ssoSubject?: string,
status: 'invited' | 'active' | 'suspended' | 'locked',
profile: { name, locale, timezone, avatarUrl, phone? },
lastLoginAt, failedAttempts, lockedUntil,
invitedBy, acceptedAt, createdAt, updatedAt
```

`models/UserRole.js` documents the join row:

```
_id, tenantId, userId, roleId,
scope?: { resourceType?, resourceId? },  // optional narrowed scope
grantedBy, grantedAt, expiresAt?
```

## Architectural shape

- Service: `services/admin.service.js` re-used for user CRUD; a future
  `services/user.service.js` will own user-specific rules.
- Repository: `repositories/admin.repository.js` is the reference shape;
  `repositories/user.repository.js` mirrors it under `tenantId` scoping.
- All user endpoints pass through `tenantIsolation.middleware.js`.

## Coding guidelines

- A user can never appear in more than one tenant (except for cross-tenant
  service accounts - planned Phase 4+).
- Email uniqueness is per-tenant (not global).
- Invitations expire after 7 days (Phase 2 setting).
- Every user-creation / suspension is audited.

## Future extension

- Enterprise: multiple users in multiple tenants under one org membership.
- Bulk import via CSV (covered by `connectors/csv/` reusing the CSV
  connector contract).
- SCIM 2.0 provisioning (Phase 4+).
