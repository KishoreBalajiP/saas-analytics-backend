# IAM / permissions - Dynamic RBAC

Permissions are the atomic unit of authorisation. They are stored as data
and describe exactly **what action a caller is allowed to perform on which
module**. The system must NEVER hardcode a permission check; every check
flows through `permission.middleware.js` against the `models/Permission.js`
table.

## Conceptual model

```
MODULE       + ACTION         ->  PERMISSION
(e.g.        + (e.g. CREATE)      (e.g. analytics.create)
 analytics)

ROLE         + permissionIds[]   ->  ROLE has many PERMISSIONS
ACTOR        + roleIds[]         ->  ADMINROLE / USERROLE mapping
PERMISSION   + scope?            ->  optional scope narrows to resource
```

## Modules (Phase 2 seeds)

These are the dynamic modules the system knows about. Each module defines
its allowed actions. New modules are added at runtime via `/permissions/
modules`; the cache invalidates and the next request sees them.

| Module id      | Display name          |
| -------------- | --------------------- |
| `iam`          | Identity & Access     |
| `platform`     | Platform Management   |
| `governance`   | Audit & Compliance    |
| `analytics`    | Dashboards & Reports  |
| `connectors`   | Data Connectors       |
| `tenants`      | Tenant Management     |
| `users`        | User Management       |
| `roles`        | Role Management       |
| `settings`     | Settings              |
| `feature_flags`| Feature Flags         |
| `master_data`  | Master Data           |
| `monitoring`   | Monitoring            |
| `notifications`| Notifications         |
| `email_templates`| Email Templates     |
| `audit_logs`   | Audit Logs            |
| `access_logs`  | Access Logs           |
| `compliance`   | Compliance            |
| `support`      | Support               |

## Actions (catalogue)

Actions are platform-defined strings, not enums in code. **However** for
self-documentation and tooling, Phase 2 ships the canonical catalogue:

```
view        - read a record or list
create      - create
update      - modify
delete      - delete
export      - generate a downloadable artefact
approve     - approve a workflow step
suspend     - disable an entity
restore     - re-enable a suspended entity
assign      - grant a role/permission
configure   - change platform/module settings
```

A module MAY register additional actions, but the canonical set above must
remain available on every module so dashboards and policy UIs are uniform.

## Data shapes (architecture only)

`models/Module.js`:

```
_id, key (unique), name, description?,
parentKey?: string,        // for hierarchies (planned)
createdAt, updatedAt
```

`models/Permission.js`:

```
_id, moduleId (ref), action: string,
key: string,               // unique composite key, e.g. 'analytics.export'
description?,
isSystem: boolean,
createdAt, updatedAt
```

`models/RolePermission.js`:

```
_id, roleId (ref), permissionId (ref),
grantedBy, grantedAt
```

`models/UserRole.js` / `models/AdminRole.js`:

```
_id, actorId (User or Admin), actorType: 'user'|'admin',
roleId, tenantId | null,
scope?: { resourceType, resourceId },
grantedBy, grantedAt, expiresAt?
```

## Planned endpoints (`/api/v1/permissions`)

- `GET    /modules`                     - list registered modules
- `POST   /modules`                     - register a new module
- `GET    /modules/:key/actions`        - actions available on a module
- `GET    /`                            - list permissions (filterable by module/action)
- `POST   /`                            - create a (module, action) permission
- `POST   /bulk`                        - bulk create (idempotent)
- `DELETE /:id`                         - delete (only if no roles assigned)

## Coding guidelines

- Every permission key MUST be `<module_key>.<action>` exactly.
- `permission.middleware.js` accepts a static `(module, action)` pair OR
  a dynamic `req => (module, action)` resolver (for tenant-scope modules).
- `rbac.middleware.js` does coarse checks ("must have at least one role").
- `modulePermission.middleware.js` enforces "must have ANY permission on
  module X" - useful for menu visibility.
- `permission.middleware.js` is the only fine-grained check.
- A safe default of `deny` MUST apply when no rule matches.

## Future extension

- ABAC (attribute-based) conditions: `timeOfDay`, `ipRange`, `tenant`.
- Temporary permission elevation with audit hook.
- Bulk-import RBAC matrices via CSV (using `connectors/csv/`).
