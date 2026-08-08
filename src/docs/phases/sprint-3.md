# Sprint 3 — Multi-Tenancy

> **WHAT this is:** the plan for Sprint 3 — the tenant lifecycle, onboarding,
> settings, feature flags and the login gate that enforces tenant status.
> **WHY it exists:** every customer is a tenant; the platform must provision,
> isolate, suspend and retire tenants safely, and only `active` tenants may
> authenticate.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-3.md`.

---

## Current Status

> **Status:** ✅ Complete.
> **Sprint:** Sprint 3 — Multi-Tenancy.
> **Owner:** Engineering team.
> **Tests:** 232 pass (13 tenant integration + 10 setting-service tests
> added). `npm run ci:guards` → 5/5 green.

---

## Purpose

Multi-tenancy is the platform's core promise. Sprint 3 ships the tenant as a
first-class lifecycle object: a `pending` tenant is provisioned, onboarded
into `active` (owner + default roles + permissions + settings + feature
flags), can be suspended/disabled/archived with a session + cache cascade,
and is only ever authenticated while `active`.

## Scope

- **Tenant model & repository**: `status` lifecycle (`pending`/`active`/
  `suspended`/`disabled`/`archived`), `onboardingStatus`, `ownerId`,
  lifecycle timestamps + reasons, immutable `slug`.
- **Tenant repository**: create/list/get/update, `countByStatus`, and the four
  atomic lifecycle transitions.
- **Tenant service**: `create` (pending, optional `initialize`), `list`,
  `getById`, `update` (profile fields only — status/slug/owner rejected),
  `lifecycle` facade, `initialize`, `statistics`, `settings` group surface,
  `members`, `billing`, `changeOwner`.
- **Onboarding service** (`tenantInitialization.service.js`): idempotent seed
  of modules + permissions, platform settings, feature flags, four default
  roles (`Owner`/`Admin`/`Manager`/`Viewer`) with their permission keys, and
  the owner user; flips `pending → active`/`ready`.
- **Lifecycle service** (`tenantLifecycle.service.js`): suspend/restore/
  disable/archive with the status graph, session revocation
  (`revokeAllForTenant`) and RBAC-cache scope invalidation, audited.
- **Auth gate** (`auth.service.js`): login rejects unknown/malformed tenant
  ids generically and returns 403 for non-`active` tenants; refresh revokes the
  session family when the tenant is inactive.
- **Settings service** (`Setting` model + `setting.service.js`): typed values
  (`string`/`number`/`boolean`/`duration`/`json`), `platform` + `tenant`
  scopes, secret redaction, effective inheritance (tenant > platform > default)
  and cache key `settings:<scope>:<holder>:<key>` (TTL 60s) with per-key
  invalidation; read-only keys hard-rejected on tenant overrides.
- **Tenant settings surface** (`tenantSettings.service.js`): grouped effective
  read, idempotent platform-default seed, tenant override upsert, read-only +
  unknown-key rejection.
- **Feature-flag service** (`FeatureFlag` model + `featureFlag.service.js`):
  default catalogue seed, rollout strategies (`all`/`tenantId`/`percentage`/
  `attribute`), deterministic bucketing, cached enabled-catalogue
  (`feature-flag:enabled`, TTL 60s).
- **Tenant statistics** (`tenantStatistics.repository.js` + service): aggregates
  over `User`/`Session`/`AuditLog` only.
- **Routes / controller / validator**: real, admin-gated
  `POST/GET/PATCH/POST... /api/v1/tenants/*`; `iam.tenants.*` permission keys.

## Deliverables

### Models

- `src/models/Tenant.js` — extended with lifecycle + onboarding fields.
- `src/models/Setting.js` — real schema (`SCOPES`, `TYPES`, soft-delete,
  `tenantScope({ optional: true })`, paginate, optimistic-concurrency, audit).
- `src/models/FeatureFlag.js` — real schema (`ROLLOUT_STRATEGIES`,
  `VALUE_TYPES`, audit, soft-delete, paginate, optimistic-concurrency).

### Repositories

- `src/repositories/tenant.repository.js` — extended (lifecycle + counts).
- `src/repositories/setting.repository.js` — new (coerce, upsert-key, list).
- `src/repositories/featureFlag.repository.js` — new (enabled lookup, CRUD).
- `src/repositories/tenantStatistics.repository.js` — new (tenant activity).

### Services

- `src/services/tenant.service.js` — facade.
- `src/services/tenantInitialization.service.js` — onboarding.
- `src/services/tenantLifecycle.service.js` — transitions + cascade.
- `src/services/tenantSettings.service.js` — grouped settings.
- `src/services/setting.service.js` — settings business logic + redaction.
- `src/services/featureFlag.service.js` — flag catalogue + resolution.
- `src/services/tenantStatistics.service.js` — tenant activity numbers.
- `src/modules/iam/auth/auth.service.js` — tenant-status gate (extended).

### Controllers / Validators / Routes

- `src/controllers/tenant.controller.js` — thin handlers.
- `src/validators/tenant.validator.js` — create/list/update/lifecycle/
  initialize/members/settings/owner schemas.
- `src/routes/tenant.routes.js` — `/api/v1/tenants/*`, `adminAuth` +
  `permission('iam.tenants', <action>)`.

### Cache fix (incident)

- `src/cache/memory.js` `getOrSet` no longer memoizes `null`/`undefined`
  misses, matching Redis semantics — otherwise a missing tenant setting
  override was cached negatively and a later override was not picked up until
  TTL expiry.
- `tenantSettings.updateGroup` now invalidates the `resolveEffective` cache for
  each overridden key on write.

## Dependencies

- Sprint 1 (auth) — login/refresh are gated by tenant status.
- Sprint 2 (IAM) — modules, permissions, roles, platform admin auth.

## Testing

- Integration (`tests/tenants/tenant.integration.test.js`, 13 tests): create /
  detail / list, status-rejection on PATCH, onboarding + owner login + role
  seeding, idempotent re-init, suspend→login 403 + session cascade, restore,
  disable/archive + terminal 409, members, settings inheritance + redaction +
  read-only rejection, feature-flag rollout semantics, stats + billing,
  changeOwner.
- Service (`tests/services/setting.service.test.js`, 10 tests): value
  coercion, secret redaction, effective inheritance, cache invalidation on
  write, read-only protection.
- Cache (`tests/cache/memory.test.js`) — getOrSet memoization still holds for
  non-null values.

## Risks

1. **Negative cache** — fixed by not memoizing `null` misses.
2. **Session cascade on suspend** — `revokeAllForTenant` is best-effort; a
   session created after revocation but before the lock is short-lived.
3. **Dashboard/Report are schema-less stubs** — statistics deliberately do not
   import them; counts come from `User`/`Session`/`AuditLog`.

## Definition of Done

- [x] All deliverables merged.
- [x] Tenant lifecycle (suspend/restore/disable/archive) + session cascade.
- [x] Auth login/refresh tenant-status gate.
- [x] Idempotent onboarding (owner + 4 roles + settings + flags).
- [x] Settings effective inheritance + secret redaction + read-only protection.
- [x] Feature-flag catalogue + per-tenant rollout.
- [x] `/api/v1/tenants/*` real, admin-gated, validated.
- [x] Cache invalidation correct (no negative cache; per-key invalidation).
- [x] `npm test` green (232 pass); `npm run ci:guards` green (5/5).
- [x] `STATUS.md`, `CHANGELOG.md`, module READMEs + `AI_CONTEXT.md` updated.

## Expected Outcome

A platform admin can provision a tenant end-to-end via `/api/v1/tenants`,
onboard it to `active`, suspend it (which immediately blocks logins and kills
live sessions), and retire it to `archived` (terminal). Tenants own their
settings and feature flags with safe inheritance and secret redaction.

## Real-world Examples

- An admin suspends a tenant for abuse: existing sessions die instantly and
  the tenant user's next login returns 403.
- An admin overrides `email.from_name` for a tenant; the change is visible on
  the next read (cache invalidated per-key).

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase (in progress)
- [`sprint-2.md`](./sprint-2.md) — previous (IAM)
- [`sprint-4.md`](./sprint-4.md) — next (Connector Platform)
- [`../backend/multi-tenancy.md`](../backend/multi-tenancy.md) — deep dive

## Last Updated

- **Sprint:** Sprint 3 close (Multi-Tenancy)
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-07
- **Author:** Engineering (Sprint 3)
