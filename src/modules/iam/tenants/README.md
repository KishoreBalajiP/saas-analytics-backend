# IAM / tenants

A Tenant is an organisation: a billing unit, a data-scope unit, and the
default audience for analytics. Every record owned by the business carries
a `tenantId`; every request runs through `tenantIsolation.middleware.js`.

## Planned endpoints (`/api/v1/tenants`)

- `POST   /`                 - create tenant (admin-gated)
- `GET    /`                 - list tenants (admin-only)
- `GET    /:id`              - tenant detail
- `PATCH  /:id`              - tenant profile (name, planId, status)
- `POST   /:id/suspend`      - blocks all logins and API access
- `POST   /:id/restore`      - reverses suspend
- `GET    /:id/members`      - users + admins in this tenant
- `GET    /:id/billing`      - plan + invoice history (Phase 3+)
- `GET    /:id/settings`     - tenant-scoped settings (delegated)

## Data shape (architecture only)

`models/Tenant.js` documents:

```
_id, name, slug (unique), logoUrl?,
planId (ref: platform/master-data/subscriptionPlans.id),
status: 'trial' | 'active' | 'suspended' | 'churned',
billingEmail?, country (ISO-3166), defaultLocale, defaultTimezone,
defaultCurrency,
trialEndsAt?, suspendedAt?, suspendedReason?,
createdAt, updatedAt, createdBy, updatedBy
```

Indexes: unique(slug), {status: 1, createdAt: -1}, {planId: 1}.

## Sub-resources owned by a Tenant

```
Admins      - none, by design (admins are platform-scoped)
Users       - 1..N
Roles       - 1..N (tenant-defined roles built from permissions)
Connectors  - 1..N
Dashboards  - 1..N
Reports     - 1..N
Settings    - 1..N (key/value overrides)
```

## Architectural shape

- HTTP / routes: `src/routes/tenant.routes.js`.
- Controller: `src/controllers/admin.controller.js` re-used; a future
  `tenant.controller.js` owns tenant-only views.
- Service: `src/services/admin.service.js` carries the CRUD shape; a
  future `services/tenant.service.js` enforces tenant-only rules.
- Repository: `src/repositories/admin.repository.js` (reference shape).

## Coding guidelines

- `slug` is immutable once set (use `displayName` for rename).
- Suspending a tenant must cascade to all user sessions (queued).
- Tenants can be soft-deleted only after 30-day retention + GDPR purge.
- All writes audited via `audit.middleware.js`.

## Future extension

- Hierarchical tenants (parent / child) for enterprise in Phase 4+.
- Per-tenant API keys + rate-limit overrides.
