# IAM / roles

Dynamic Roles: a Role is a *named collection of permissions*. Roles are
data, defined by admins, evaluated by `rbac.middleware.js`. There are NO
hardcoded roles in the codebase (except the bootstrap `super_admin` which
exists to break the chicken-and-egg).

## Planned endpoints (`/api/v1/roles`)

- `GET    /`              - list roles (optionally tenant-scoped)
- `POST   /`              - create role
- `GET    /:id`           - role + permissions
- `PATCH  /:id`           - rename / change description
- `POST   /:id/permissions`    - add permission(s)
- `DELETE /:id/permissions/:p` - revoke permission
- `DELETE /:id`                 - delete role (refuses if assignments exist)

## Data shape (architecture only)

`models/Role.js`:

```
_id, tenantId | null,                  // null = platform role
name, description?,
level: 'platform' | 'tenant',
isSystem: boolean,                     // platform-defined, can't be edited
permissionIds: string[],               // refs to models/Permission.js
createdAt, updatedAt, createdBy, updatedBy
```

`models/AdminRole.js` and `models/UserRole.js`: the join rows that
attach a role to an actor (admin or user) with optional scope and expiry.

## Built-in (seeded) roles (Phase 2)

| Name                    | Scope    | Notes                                   |
| ----------------------- | -------- | --------------------------------------- |
| `super_admin`           | platform | bootstrap, can't be deleted             |
| `platform_admin`        | platform | manages platform modules                |
| `support_admin`         | platform | tenant-scoped, read-only escalation     |
| `tenant_owner`          | tenant   | one per tenant by default               |
| `tenant_admin`          | tenant   | tenant-wide admin                       |
| `tenant_member`         | tenant   | default end user                        |

These are *seeds only*. New roles are created at runtime through the
`/roles` API.

## Coding guidelines

- Role assignment never alters permission docs; only `*Role` join docs.
- `isSystem` roles cannot be edited; admins must clone-and-edit.
- Deleting a role uses a soft delete and requires no active assignments.
- Role *checks* happen via `rbac.middleware.js` which reads from the
  cached role/permission map (cache key: `iam:rbac:<tenantId-or-platform>`).

## Future extension

- Role inheritance (`extends: roleId`).
- Temporary grants via `expiresAt`.
- Per-resource grants via `scope`.
- Permission categories (grouped UI in the Admin Portal).
