# IAM / tenants

A Tenant is an organisation: a billing unit, a data-scope unit, and the
default audience for analytics. Every business record carries a `tenantId`;
every request resolves a `tenantId` via `resolveTenant` (JWT-backed).

## Real endpoints (`/api/v1/tenants`) — Sprint 3

All tenant-management routes are **platform-admin gated** (`adminAuth` +
`iam.tenants.*` permission) and validated.

- `POST   /`                 — create a tenant (`status: pending`; optionally `initialize: true` to run onboarding in one call).
- `GET    /`                 — list tenants (paged, `status` / `search` filters).
- `GET    /:id`              — tenant detail.
- `PATCH  /:id`              — update profile fields (`name`, `planId`, `billingEmail`, `country`, locale/timezone/currency, `trialEndsAt`, `logoUrl`). `status`, `slug` and `ownerId` are **rejected** here — they change via the dedicated endpoints.
- `POST   /:id/suspend`      — temporary block (409 if not `active`).
- `POST   /:id/restore`      — re-open a `suspended`/`disabled` tenant → `active`.
- `POST   /:id/disable`      — longer-term block (`active`/`suspended` → `disabled`).
- `POST   /:id/archive`      — terminal, read-only (`archived`); every later transition is 409.
- `POST   /:id/init`         — run (or safely re-run) onboarding.
- `GET    /:id/members`      — paginated tenant users with their resolved role names.
- `GET    /:id/stats`        — `{ userCount, activeSessionCount, auditEventCount, lastActivityAt }`.
- `GET    /:id/billing`      — plan + billing facts.
- `GET    /:id/settings`     — effective settings, grouped (tenant override > platform > built-in default).
- `PATCH  /:id/settings`     — upsert tenant overrides (read-only keys hard-rejected).
- `POST   /:id/owner`        — reassign the tenant owner (user must already exist in the tenant).

## Data shape (`models/Tenant.js`)

```
_id, name, slug (unique, immutable), logoUrl?,
planId?, status: 'pending'|'active'|'suspended'|'disabled'|'archived' (default 'pending'),
billingEmail?, country (ISO-3166-1 alpha-2),
defaultLocale (default 'en'), defaultTimezone (default 'UTC'), defaultCurrency (default 'USD'),
trialEndsAt?,
ownerId?, onboardingStatus: 'not_started'|'initializing'|'ready'|'failed' (default 'not_started'),
suspendedAt?, suspendedReason?, disabledAt?, disabledReason?, archivedAt?, archivedReason?,
createdBy?, updatedBy?, deletedAt?, deletedBy?, createdAt, updatedAt
```

Indexes: `unique(slug)`, `{status, createdAt:-1}`, `{planId:1}`, `{ownerId:1}`.

## Lifecycle & auth gate

A tenant starts `pending` and becomes `active` only after onboarding completes
(`onboardingStatus: 'ready'`). **Only `active` tenants may authenticate:**

- Login (`/api/v1/auth/login`) rejects unknown/malformed tenant ids with the
  generic `INVALID_CREDENTIALS` (no enumeration) and returns **403** for a
  known-but-inactive tenant.
- Refresh (`/api/v1/auth/refresh`) revokes the whole session family when the
  tenant is missing or not active (`tenant_inactive`).

Lifecycle transitions cascade:

- `suspend` / `disable` / `archive` → revoke **every** active session in the
  tenant (`sessionRepository.revokeAllForTenant`) so a blocked tenant cannot
  authenticate through a lingering token, plus invalidate its RBAC cache scope.
- Same-status transitions are idempotent no-ops; illegal transitions are
  `409`; `archived` is terminal (every transition → `409`).

## Onboarding (idempotent)

`POST /:id/init` seeds, exactly once:

1. Built-in modules + tenant-scoped permissions (`iam.*`, `users.*`,
   `roles.*`, `settings.*`, `feature_flags.*`, `analytics.*`,
   `connectors.*`, `dashboards.*`, `reports.*`, `notifications.*`,
   `master_data.*`, `email_templates.*`).
2. Platform settings (the 24-row settings catalogue).
3. Platform feature flags (default catalogue).
4. Four default roles — `Owner`, `Admin`, `Manager`, `Viewer` — each granted
   its permission keys.
5. The owner user (active when a password is supplied, `invited` otherwise),
   assigned the `Owner` role.
6. Flips `status → active`, `onboardingStatus → ready`, sets `ownerId`.

Re-running `init` on an already-ready tenant is a no-op returning
`alreadyInitialized: true`.

## Tenant settings

- `GET /:id/settings?group=<group>` — effective values for a group
  (tenant override > platform row > built-in default). The `feature_flags`
  group is delegated to the feature-flag catalogue.
- `PATCH /:id/settings` — upsert tenant overrides. Read-only keys
  (`security.password_min_length`, `security.lockout_threshold`,
  `billing.trial_days`, `storage.*`) are hard-rejected (`403`).
- Secret values (`email.smtp_password`) are redacted (`value: null`,
  `redacted: true`) unless `includeSecrets=true` (platform admins).
- Writes invalidate the per-key `resolveEffective` cache so a tenant override
  is visible immediately.

## Tenant statistics

`/tenants/:id/stats` aggregates live activity across `User`, `Session` and
`AuditLog` only (`Dashboard`/`Report` models are schema-less placeholders and
are intentionally not imported).

## Sub-resources owned by a Tenant

```
Users       - 1..N (tenant-scoped)
Roles       - 1..N (tenant-defined, built from permissions)
Sessions    - 0..N (revoked on lifecycle transitions)
Settings    - key/value overrides (inherit + override)
Feature flags are resolved against the platform catalogue (per-tenant grants via the tenantId strategy).
```

Platform admins are **not** tenant-owned; they live at `iam.admins`.

## Coding guidelines

- `slug` is derived from `name` and immutable once set.
- Status changes **never** go through `PATCH /:id`; they use the lifecycle
  endpoints so the status graph is enforced in one place.
- `by` attribution comes from the admin token, never the request body.
- Tenants soft-delete only (retention window enforced by the `softDelete` plugin).

## Future extension

- Hierarchical tenants (parent / child) for enterprise.
- Per-tenant API keys + rate-limit overrides.
- Subdomain-based tenant resolution (Phase 4).
