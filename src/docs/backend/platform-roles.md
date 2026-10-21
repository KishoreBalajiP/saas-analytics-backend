# Backend — Platform roles and admin scope (roadmap 2.1)

> **WHAT this is:** how platform administrators are authorised: the four
> built-in platform roles, `adminType` as a ceiling, `tenantScope`
> confinement, and the guardrails around them.
> **WHERE it lives:** `src/docs/backend/platform-roles.md`.
> **Source of truth:** `src/constants/platformRoles.js` (roles and grants),
> `src/middleware/adminScope.middleware.js` (scope), `src/services/admin.service.js`
> (guardrails), `scripts/ci/check-routes.js` (CI rule).

## Built-in platform roles

| Role | adminType | Grants (summary) |
| --- | --- | --- |
| `super_admin` | `super` | Every platform catalogue key: administrators, roles, archive, ownership transfer, secret settings, billing overrides. |
| `platform_admin` | `platform` | Tenants (view, create/onboard, update, suspend/disable/restore, invitations), access-request review, plan catalogue edits, master-data maintenance (no delete), configuration view/update; view of admins, roles, audit, access logs, compliance, monitoring, support diagnostics and billing. |
| `support_operator` | `support` | Support tooling (`support.view` lookups, `support.update` recovery/session revocation/broadcast, `support.configure` impersonation) plus read access to tenants, audit logs, access logs and compliance within its scope. |
| `auditor` | `auditor` | Read-only everywhere, including `audit_logs.export` / `access_logs.export`. |

The exact key lists are in `src/constants/platformRoles.js`; the
role-by-route matrix is pinned by `tests/platform-roles/role-matrix.integration.test.js`.

`npm run db:permissions` (`adminBootstrap.service#syncPlatformCatalogue`)
creates the roles and converges each one to exactly its definition. The
built-in roles cannot be edited, deleted or shadowed over HTTP; create a
custom role for anything else. `npm run bootstrap:admin` grants the built-in
role matching the new admin's type.

## Permission keys added by 2.1

| Key | Route |
| --- | --- |
| `iam.access_requests.view` | `GET /access-requests` |
| `iam.access_requests.approve` | `POST /access-requests/:id/approve` and `/reject` (role limited to Viewer / Manager) |
| `master_data.create` / `update` / `delete` / `export` | `POST/PATCH/DELETE /master-data/:catalogue[...]`, import, export |
| `support.view` / `support.update` | support lookups / recovery, session revocation, broadcast (`support.configure` stays on impersonation) |
| `billing.entitlements.view` | entitlement and override reads (`override` stays on writes) |

## Guardrails

- **adminType is a ceiling.** Super > Platform > Support > Auditor. A
  built-in role above the admin's type cannot be granted (409
  `ROLE_ABOVE_ADMIN_TYPE`); lowering the type revokes built-in roles above
  it. Legacy bootstrap roles (`super`, `platform`, `support`) can no longer
  be granted.
- **Auditors are read-only.** An admin whose live `adminType` is `auditor`
  is refused every action other than `view` / `export` by the permission
  middleware, even if a custom role grants it; `/admin-auth/me` lists only
  its read-only keys so the UI matches enforcement.
- **No self-modification; only supers change privileges** (Phase 0), and
  **only supers manage supers** (update, suspend, restore).
- **Last active super admin.** Suspension and demotion use a
  compare-and-set write, a re-count after the write and a compensating undo,
  so concurrent requests cannot remove the last active super admin (409
  `LAST_SUPER_ADMIN`). Revoking the last live super-admin role grant is
  refused the same way.

## Tenant scope

`Admin.tenantScope` confines an admin to one tenant. `adminAuth` exposes the
**live** value as `req.admin.tenantId` (re-scoping applies on the next
request). Over HTTP a scope must name an existing tenant, and
`PATCH /admin/admins/:id` with `{ "tenantScope": null }` (or `""`) clears it
(super admins only); the cross-tenant value `*` (`tenantIsolation`'s
`CROSS_TENANT_SCOPE`, settable only by system callers) means every tenant and
is treated as platform-wide. Every admin route declares one guard after
`permission(...)`:

| Guard | Used on | Scoped admin |
| --- | --- | --- |
| `adminScope.platform()` | admins, roles, permissions, master-data writes, plans, monitoring, access requests, override revoke, billing reconcile | 403 `ADMIN_SCOPE_DENIED` |
| `adminScope.tenant(read)` | `/tenants/:id/*`, support lookups and broadcast, `/admin/subscriptions/:tenantId/*`, `/admin/entitlements/*/:tenantId` | only its own tenant |
| `adminScope.filtered(read)` | tenant list, dashboard summary, audit logs, access logs, compliance, user-targeted support actions, subscription and override lists | handler clamps to the scope; explicit other-tenant filters 403; other-tenant records 404 |

Effective permissions of an admin are its platform grants plus its grants
scoped to its own tenant; `GET /admin-auth/me` resolves the same set and
returns `scope: { type: 'platform' | 'tenant', tenantId }`. A tenant-scoped
grant is only accepted for an admin scoped to that tenant, and is revoked
with `DELETE /admin/admins/:id/roles/:roleId?tenantId=<tenant>`.

## CI

`npm run ci:check-routes` fails when an admin route (one that mounts
`adminAuth`, directly or with `router.use(adminAuth)`) has no `permission(...)`
middleware. Exceptions need a reason: the file allow-list in the script
(`admin-auth.routes.js`, self-service) or a `ci:permission-exempt: <reason>`
annotation on the route.

## Migration (operator, approval required)

1. `npm run db:indexes -- --apply`
2. `npm run db:permissions -- --apply` (creates the built-in roles)
3. `npm run db:platform-roles` — dry run: every admin's before/after
   permissions (`--json` for full sets)
4. `npm run db:platform-roles -- --apply` — moves admins off the legacy
   roles. Admins whose built-in role would add a permission they do not
   already hold are reported `needs_review` and left unchanged; custom and
   tenant-scoped grants are never touched.

## Extending (later packages)

Register new modules in `models/Module.js`, append keys to the built-in roles
that should hold them in `constants/platformRoles.js` (auditor keys must be
read-only; the module throws otherwise), gate routes with `permission(...)` and
an `adminScope.*` guard, add a row to the role matrix test, and run
`npm run db:permissions -- --apply`.
