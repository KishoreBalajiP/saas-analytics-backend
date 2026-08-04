# IAM / admins

Platform Admins: the humans who run the SaaS. They are NOT tenant users.

## Roles (planned, fully dynamic via `iam/roles/`)

| `adminType` | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| `super`     | Root. Cannot be deleted, only demoted by another super.            |
| `platform`  | Operates one or more Platform modules (settings, master-data).    |
| `support`   | Tenant-scoped, read-only escalation. Impersonation needs reason.  |

## Planned endpoints (`/api/v1/admin`)

- `GET    /admins`               - list (filtered, paginated)
- `POST   /admins`               - create + invite
- `GET    /admins/:id`           - fetch with current roles
- `PATCH  /admins/:id`           - profile / status / MFA
- `POST   /admins/:id/suspend`   - suspend (records reason)
- `POST   /admins/:id/restore`   - restore
- `POST   /admins/:id/roles`     - assign role (uses RBAC)
- `DELETE /admins/:id/roles/:r`  - revoke role
- `GET    /admins/:id/audit`     - per-admin audit trail

## Data shape (architecture only, no schema)

`models/Admin.js` documents:

```
_id, email (unique, lower),
passwordHash (Argon2id),
mfaSecret?, mfaEnabled,
status: 'pending' | 'active' | 'suspended' | 'locked',
adminType: 'super' | 'platform' | 'support',
tenantScope?: tenantId | null,   // present only for support admins
profile: { name, locale, timezone, avatarUrl },
lastLoginAt, failedAttempts, lockedUntil,
createdAt, updatedAt, createdBy, updatedBy
```

## Coding guidelines

- `super` admins are created only via bootstrap CLI (Phase 2 setup).
- All admin mutations go through `audit.middleware.js`.
- Suspending a `super` admin is impossible; demotion requires another
  `super` admin + MFA + 24h cool-down (planned).
- All admin endpoints are gated by `adminAuth.middleware.js` + RBAC.

## Future extension

- Service accounts (`models/Admin.js#serviceAccount: true`).
- IP allow-listing per admin type.
- Onboarding flow: invite -> email -> first login -> forced MFA.
