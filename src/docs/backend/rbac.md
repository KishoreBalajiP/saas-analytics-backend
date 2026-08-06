# Backend — RBAC (Dynamic Roles & Permissions)

> **WHAT this is:** the deep-dive on the dynamic RBAC engine.
> **WHY it exists:** permissions are data, not code. The engine must
> be safe, fast and cache-coherent.
> **HOW to use it:** read *Architecture* before implementing;
> re-read *Cache Strategy* before merging.
> **WHEN to update it:** as the engine evolves.
> **WHERE it lives:** `src/docs/backend/rbac.md`.

---

## Purpose

> **WHAT this is:** the deep-dive on RBAC.
> **WHY it exists:** permissions are data; the engine must be safe,
> fast and cache-coherent.
> **HOW to use it:** read *Architecture* before implementing;
> re-read *Cache Strategy* before merging.
> **WHEN to update it:** as the engine evolves.
> **WHERE it lives:** `src/docs/backend/rbac.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 3 implementer** | Has the full plan. |
| **Tech lead** | Has the cache strategy. |

## Current Status

> **Status:** `Planned` — Sprint 3.
> **Sprint:** Sprint 3.
> **Owner:** Engineering team.

## Business Perspective

Every business endpoint must check permissions. RBAC is the engine
that does it: roles are collections of permissions; permissions are
`<module>.<action>` strings; the cache holds the resolved set for
fast checks.

## Technical Perspective

`Module`, `Permission`, `Role`, `RolePermission` models. RBAC cache
at `iam:rbac:<scope>` (scope = `platform` or `tenant:<id>`).
`rbac`, `permission`, `modulePermission`, `denyIf` middleware.
Default deny.

## Architecture

```
┌─────────────────────┐
│  Module             │  e.g. "iam.users"
└─────────────────────┘
┌─────────────────────┐
│  Permission         │  e.g. "iam.users.delete"
│  { module, action } │
└─────────────────────┘
┌─────────────────────┐
│  Role               │  { name, scope, isSystem, permissions[] }
│                     │   system roles are immutable
└─────────────────────┘
┌─────────────────────┐
│  RolePermission     │  join table
└─────────────────────┘

            ┌──────────────────────────┐
            │  Cache (Redis)            │
            │  iam:rbac:<scope>         │
            │  ── permissions: string[] │
            │  TTL: 5 min               │
            │  Invalidate on write       │
            └──────────────────────────┘
                      ▲
                      │ invalidate on role/permission write
                      │
            ┌──────────────────────────┐
            │  Middleware chain         │
            │   requireRole(...)        │
            │   permission(mod, act)    │
            │   modulePermission(mod)   │
            │   denyIf(...)              │
            │   default: deny            │
            └──────────────────────────┘
```

## Built-in Seeds

### Modules (18)

`iam`, `platform`, `governance`, `analytics`, `connectors`, `tenants`,
`users`, `roles`, `settings`, `feature_flags`, `master_data`,
`monitoring`, `notifications`, `email_templates`, `audit_logs`,
`access_logs`, `compliance`, `support`.

### Actions (10 per module)

`view`, `create`, `update`, `delete`, `export`, `approve`,
`suspend`, `restore`, `assign`, `configure`.

### System roles (6)

| Role | Scope | Permissions |
| --- | --- | --- |
| `super_admin` | platform | all |
| `platform_admin` | platform | platform, tenants (CRUD), settings, feature_flags, master_data, email_templates, monitoring, audit_logs (read), access_logs (read), compliance (read) |
| `support_admin` | platform (with `tenantScope: '*'`) | support.*, audit_logs (read), compliance (read) |
| `tenant_owner` | tenant | all within the tenant |
| `tenant_admin` | tenant | users, roles (custom), feature_flags, settings, connectors, notifications, audit_logs (read) |
| `tenant_member` | tenant | dashboards (read), reports (read), notifications (read) |

## Real-world Examples

### Adding a permission to a custom role

```http
POST /api/v1/roles/<role-id>/permissions
Authorization: Bearer <tenant-owner-token>
{ "permission": "iam.users.delete" }
```

1. Server adds the permission to the role.
2. Server invalidates `iam:rbac:<tenant-id>`.
3. Within 5 min (or immediately on next read), every instance has
   the new permission set.

### Checking a permission

```js
import { permission } from '../../middleware/permission.middleware.js';

router.post(
  '/users',
  authenticate,
  permission('iam.users', 'create'),
  userController.create,
);
```

If the actor's role does not include `iam.users.create`, the
middleware returns `403 FORBIDDEN`.

## Cache Strategy

| Key | Value | TTL | Invalidated on |
| --- | --- | --- | --- |
| `iam:rbac:platform` | array of permission strings | 5 min | role or permission write at platform scope |
| `iam:rbac:tenant:<id>` | array of permission strings | 5 min | role or permission write within the tenant |

Stale cache is a privilege-escalation window. Worst case after a
write: 5 min. Acceptable; documented; mitigated by manual
invalidation hook.

## Best Practices

| Do | Why |
| --- | --- |
| **Default deny.** | Every route mounts auth + permission explicitly. |
| **Invalidate the cache on every write.** | Stale cache = privilege escalation. |
| **Treat system roles as immutable.** | The seed is the contract. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Skipping invalidation.** | Stale permission = wrong access. |
| **Making system roles mutable.** | The seed is the contract. |
| **Hard-coding permission checks.** | Permission keys must come from the data, not from a string in code. |

## Future Work

| Item | Phase |
| --- | --- |
| **Bulk operations** | Phase 3 |
| **Time-bound role assignments** | Phase 3 |
| **Permission delegation / approval workflow** | Phase 4 |

---

## Summary

RBAC is the dynamic permission engine. 18 modules, 10 actions, 6
system roles, custom per-tenant roles. Cached at
`iam:rbac:<scope>` with 5-min TTL and explicit invalidation on
write. Default deny.

## Key Takeaways

- **Permissions are data.**
- **System roles are immutable.**
- **Cache invalidation is mandatory on every write.**

## Interview Preparation

### Common Questions

- "Why are permissions data, not code?"
- "How do you prevent cache staleness?"

### Sample Answers

- **"Why data?"** — Tenants extend them. A SaaS platform cannot
  ship every customer's role in code.
- **"Cache staleness?"** — TTL is 5 min; we also invalidate on every
  role / permission write.

## Related Documents

- [`../phases/sprint-3.md`](../phases/sprint-3.md) — sprint plan
- [`../../modules/iam/permissions/README.md`](../../../src/modules/iam/permissions/README.md)
- [`../../modules/iam/roles/README.md`](../../../src/modules/iam/roles/README.md)
- [`../DECISIONS.md`](../DECISIONS.md) — ADR-007 (shared plugins)

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Sprint planned:** Sprint 3
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)