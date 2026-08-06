# Sprint 3 — RBAC (Modules, Permissions, Roles)

> **WHAT this is:** the plan for Sprint 3 — the dynamic RBAC engine.
> **WHY it exists:** Permissions are data, not code. Sprint 3 makes
> them so.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-3.md`.

---

## Purpose

> **WHAT this is:** the plan for Sprint 3 — RBAC engine.
> **WHY it exists:** Permissions are data, not code; Sprint 3 makes
> them so.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-3.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 3 implementer** | Has the full plan. |
| **Tech lead** | Has the cache-invalidation strategy. |

## Current Status

> **Status:** `Planned`.
> **Sprint:** Sprint 3.
> **Owner:** Engineering team.

## Business Perspective

Every business endpoint in Phase 2 must check permissions. Sprint 3
ships the engine that does it: roles are collections of permissions;
permissions are `<module>.<action>` strings; the cache holds the
resolved set for fast checks.

## Technical Perspective

`Module`, `Permission`, `Role`, `RolePermission` models. RBAC cache
at `iam:rbac:<scope>`. `rbac`, `permission`, `modulePermission`,
`denyIf` middleware (real). System roles seeded.

## Scope

- 18 built-in modules + 10 actions per module → 180 built-in
  permissions seeded at boot.
- 6 system roles seeded: `super_admin`, `platform_admin`,
  `support_admin`, `tenant_owner`, `tenant_admin`, `tenant_member`.
- `/roles/*` and `/permissions/*` CRUD.
- Real `rbac` / `permission` / `modulePermission` middleware.
- Cache invalidation on every role / permission write.
- Default deny: every route must explicitly allow.

## Deliverables

### Models
- `src/models/Module.js`
- `src/models/Permission.js`
- `src/models/Role.js`
- `src/models/RolePermission.js`

### Seeders
- `src/db/seeds/modules.seed.js` — 18 built-in modules
- `src/db/seeds/permissions.seed.js` — 180 built-in permissions
- `src/db/seeds/roles.seed.js` — 6 system roles

### Services
- `src/modules/iam/permissions/permission.service.js`
- `src/modules/iam/roles/role.service.js`

### Middleware (real)
- `src/middleware/rbac.middleware.js` — `requireRole`,
  `requireAdminType`
- `src/middleware/permission.middleware.js` — `permission(module,
  action)`, `denyIf(...)`
- `src/middleware/modulePermission.middleware.js` — `modulePermission(module)`

### Routes
- `src/routes/role.routes.js`
- `src/routes/permission.routes.js`

## Dependencies

- Sprint 2 (auth + IAM).

## Testing

- Unit: cache build / invalidate; permission-key shape; default-deny.
- Integration: a `tenant_member` cannot access
  `permission('iam.users', 'delete')`; a `tenant_admin` can.
- Security: cache poisoning guard (TTL + invalidation).

## Risks

1. **Cache staleness** after role change. TTL is 5 min; we also
   invalidate on every role / permission write. Verify the
   invalidation fires.
2. **Bulk operations** are deferred to Phase 3; Sprint 3 ships one
   role at a time.
3. **System roles are immutable.** Document + enforce.

## Definition of Done

- [ ] All deliverables merged.
- [ ] 18 modules + 180 permissions seeded.
- [ ] 6 system roles seeded.
- [ ] `POST /roles` creates a custom role; `POST /roles/:id/permissions`
      adds a permission; cache invalidates on both.
- [ ] `permission('iam.users', 'delete')` blocks a `tenant_member`.
- [ ] Cache TTL is 5 min; manual invalidation works.
- [ ] 90 %+ test coverage.
- [ ] `npm run ci:guards` passes.
- [ ] `STATUS.md` updated.

## Expected Outcome

Every business endpoint checks permissions; permissions are data;
system roles are immutable; custom roles are per-tenant.

## Real-world Examples

- [`05-user-journey.md`](../05-user-journey.md) personas Manager,
  Analyst, Viewer are custom roles built in this sprint on top of
  `tenant_member`.

## Best Practices

| Do | Why |
| --- | --- |
| **Default deny.** | Every route mounts auth + permission explicitly. |
| **Invalidate the cache on every role / permission write.** | Stale cache is a privilege-escalation window. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Making system roles mutable.** | The seed is the contract. |
| **Skipping cache invalidation.** | Stale permission = privilege escalation. |

---

## Summary

Sprint 3 ships the RBAC engine. Permissions are data; system roles
are immutable; cache invalidates on every write. After Sprint 3 every
business endpoint can check permissions.

## Key Takeaways

- **Default deny.** Every route mounts auth + permission.
- **Cache invalidation is mandatory** on every role / permission
  write.
- **System roles are immutable.** Custom roles are per-tenant.

## Interview Preparation

### Common Questions

- "Why are permissions data, not code?"
- "How do you prevent cache staleness?"

### Sample Answers

- **"Why data?"** — Because tenants extend them. A SaaS platform
  cannot ship every customer's role in code; customers create their
  own.

- **"Cache staleness?"** — TTL is 5 min. We also invalidate the
  cache key `iam:rbac:<scope>` on every role / permission write.
  Worst case: a privilege change takes 5 min to propagate to every
  instance. Acceptable for a multi-tenant SaaS; documented.

### Real-World Examples

- A Tenant Owner creates a "Manager" role with 5 permissions. The
  cache invalidates; within seconds, every instance has the new
  permission set.

### Common Mistakes

- Mutating system roles. The seed is the contract.
- Skipping invalidation. Stale permission = privilege escalation.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-2.md`](./sprint-2.md) — previous
- [`sprint-4.md`](./sprint-4.md) — next

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Sprint planned:** Sprint 3
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)