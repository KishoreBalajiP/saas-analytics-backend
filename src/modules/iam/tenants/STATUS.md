# Module — Status

**Sprint:** 3 — Multi-Tenancy
**Status:** ✅ Implemented
**Implements:** tenant lifecycle (create/list/detail/update), onboarding (owner + default roles + permissions + settings + feature flags), lifecycle transitions with session-cascade + auth-status gate, tenant members, statistics, settings (effective inheritance + secret redaction + read-only protection), billing, and the `/api/v1/tenants/*` admin-gated routes.

**Real source files:**

- `src/models/Tenant.js` — lifecycle statuses + onboarding flags.
- `src/repositories/tenant.repository.js`, `tenantStatistics.repository.js` — tenant-scoped data access (statistics aggregate over `User` / `Session` / `AuditLog` only).
- `src/repositories/setting.repository.js`, `featureFlag.repository.js` — typed scoped settings + feature-flag catalogue.
- `src/services/tenant.service.js` — orchestration facade.
- `src/services/tenantInitialization.service.js` — idempotent onboarding sequence.
- `src/services/tenantLifecycle.service.js` — suspend/restore/disable/archive with session + RBAC-cache cascade.
- `src/services/tenantSettings.service.js` — effective inheritance (tenant > platform > default), secret redaction, read-only protection.
- `src/services/setting.service.js`, `featureFlag.service.js` — settings + feature-flag business logic with cache invalidation.
- `src/controllers/tenant.controller.js` — thin HTTP handlers.
- `src/validators/tenant.validator.js` — request schemas.
- `src/routes/tenant.routes.js` — admin-gated `/api/v1/tenants/*` surface.
- `src/modules/iam/auth/auth.service.js` — tenant-status gate on login + refresh.

**Verified:** 232 tests pass; `npm run ci:guards` green (5/5).
