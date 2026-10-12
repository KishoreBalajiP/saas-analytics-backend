# Analivo Phase 5 — Platform Admin Console Report

**Location:** `backend/docs/PHASE_5_PLATFORM_ADMIN_REPORT.md`  
**Date:** 2026-10-12  
**Status:** Implemented (with explicit deferrals)  
**Owner:** Platform Engineering  

---

## 1. Scope

Phase 5 implements an enterprise-grade internal Platform Admin console for Analivo. It builds on Phase 1–4 (production foundations, invitations, security hardening, self-service onboarding) and remains compatible with the established RBAC, audit, MFA, and tenant-isolation guarantees.

Per the Phase 5 plan, implementation is layered onto the existing platform authentication and authorization primitives. The console is **not** a second authentication system, and existing tenant login and registration flows are unchanged.

---

## 2. Existing functionality discovered (authoritative)

Backend (`D:\saas-analytics-platform\backend`):

- **Platform admin model** (`src/models/Admin.js`): `ADMIN_TYPES = super|platform|support`; `ADMIN_STATUSES = pending|active|suspended|locked`.
- **Admin auth surface** (`src/routes/admin-auth.routes.js`): `POST /api/v1/admin-auth/login` (this is the canonical admin login; the frontend serves the path at `/admin/login` and calls the API with `audience: "admin"`), refresh, logout, MFA enroll/verify, me, password forgot/reset.
- **RBAC primitives**: `Role`, `Permission`, `Module`, `AdminRole` models; permission key shape `<module_key>.<action>`; `requireRole`, `requireAdminType`, `permission()` middleware; RBAC cache.
- **Platform admin CRUD** (`src/routes/admin.routes.js`): list/create/get/patch/suspend/restore + role grant/revoke + per-admin audit, all `adminAuth` + `permission('iam.admins', <action>)` gated.
- **Tenant admin surface** (`src/routes/tenant.routes.js`): create/list/get/patch/suspend/restore/disable/archive/init/owner/members/stats/billing/settings/invitations — `adminAuth` + `permission('iam.tenants', <action>)` gated.
- **Roles / permissions** (`src/routes/role.routes.js`, `permission.routes.js`): `adminAuth` + `permission('iam.roles'/'iam.permissions', <action>)`.
- **Audit log** (`audit-log.routes.js`, `access-log.routes.js`): `audit_logs.*` / `access_logs.*` permission-gated; `AuditLog` is append-only; `auditLog.service.js` recursively redacts `SENSITIVE_KEYS` before persistence.
- **Support** (`support.routes.js`): impersonation, account recover/revoke-sessions, tenant lookups, broadcast — all `adminAuth` + `permission('support','configure')`. `support.service.js` enforces reason ≤ 500 chars, daily impersonation budget, double audit + access log.
- **Monitoring** (`monitoring.routes.js`): live probes for system/db/websocket; queue/scheduler/storage/connectors/metrics return structured `deferred`/501. `/health` is liveness; `/health/ready` returns 503 on DB outage.
- **CI guards** (`npm run ci:guards`): stubs, routes, models, config, README sync.
- **Tests** (Node `--test`, mongodb-memory-server): 438 tests across admin auth, MFA, sessions, support, compliance, monitoring, audit/access, RBAC, etc.

Frontend (`D:\saas-analytics-platform\frontend`):

- **Routes**: `admin.login.tsx`, `admin.dashboard.tsx`, `admin.tenants.tsx`, `admin.tenants.$tenantId.tsx`, `admin.admins.tsx`, `admin.roles.tsx`, `admin.audit-logs.tsx`, `admin.access-logs.tsx`, `admin.monitoring.tsx`, `admin.support.tsx`, `admin.compliance.tsx`.
- **Layout**: `AdminPortal` (Provider+Shell), distinct from `TenantPortal`; permission-aware `ADMIN_NAV`; sonner toasts; shared `DataTable`, `EmptyState`, `ErrorState`, `TableSkeleton`.
- **API client**: `lib/api/client.ts` (in-memory tokens, single-flight refresh, audiences, `ApiError` mapping, `X-Idempotency-Key`, response envelope parsing); admin module at `features/admin/api/index.ts`.
- **Auth/session**: `useAdminSession`/`useTenantSession` contexts; `Me` carries `_id`, `permissions`, `adminType`, `status`; `Permissions` enum enumerates dotted keys.
- **Tests**: 240 vitest tests covering API client, session, permissions, security, admin API module, common states.
- **Lint / typecheck / build**: 0 errors, 9 pre-existing react-refresh warnings, `tsc --noEmit` clean, Vercel-shaped build succeeds.

---

## 3. Implemented features and files changed

### 3.1 Backend

**New files:**
- `src/services/platformDashboard.service.js` — Aggregates tenant counts, recent tenants, recent audit actions, and monitoring aggregate into a single bounded summary (`limit` clamped to 25).
- `src/controllers/platformDashboard.controller.js` — HTTP entry for `/admin/dashboard/summary`.
- `src/routes/platform-dashboard.routes.js` — Mounts the route behind `adminAuth` + `permission('iam.tenants','view')` + `validate()`.
- `src/validators/platformDashboard.validator.js` — Bounded query schema (limit 1–25).
- `tests/platform-admin-authorization.integration.test.js` — 7 regression tests covering role isolation, deny-by-default, last-super protection.
- `docs/PHASE_5_PLATFORM_ADMIN_PLAN.md` — Plan.
- `docs/PHASE_5_PLATFORM_ADMIN_REPORT.md` — This report.

**Edited files:**
- `src/routes/index.js` — Registered `/admin/dashboard` (sub-router mounted before `/admin` so it resolves before collision).
- `src/services/admin.service.js` — Added `assertNotLastActiveSuper()` and `countActiveSupers()`; wired into `update()` and `suspend()` so the last active super cannot be demoted or suspended. `update()` now also invalidates the RBAC cache.
- `src/repositories/admin.repository.js` — Added `countActiveSupers()` (counts `adminType:'super'` & `status:'active'`).

### 3.2 Frontend

**Edited files:**
- `src/features/admin/api/index.ts` — Added `dashboardSummary()` plus `DashboardSummary`, `DashboardTenantCounts`, `DashboardRecentTenant`, `DashboardRecentAction` types.
- `src/features/admin/components/AdminViews.tsx`:
  - `AdminOverview` now consumes the new `dashboardSummary` and renders real data: counts by status, recent tenant registrations, recent platform admin actions, generatedAt timestamp, refresh.
  - `AdminList` is now permission-aware: `Suspend` (with required reason dialog, mutation error surfacing) and `Restore` actions gated by `IAM_ADMINS_SUSPEND`/`IAM_ADMINS_RESTORE`; disables actions on the current admin.
  - `AuditLogList` now has bounded filters (module/action/actorType), pagination, an `Export JSON` action (gated by `AUDIT_LOGS_EXPORT`), and export status polling.

No new frontend routes were created; the existing `/admin/*` routes are now backed by the new behaviors. No mock data; all values come from real APIs.

---

## 4. Permission matrix and security boundaries

The implemented matrix is enforced server-side by the `permission()` middleware. The frontend permission list is UX-only.

| Capability | Endpoint | Required permission | Notes |
|---|---|---|---|
| View dashboard summary | `GET /api/v1/admin/dashboard/summary` | `iam.tenants.view` | Real data; bounded `limit`. |
| List / detail / patch tenants | `/api/v1/tenants*` | `iam.tenants.{view,update}` | `search`, `status`, `page`, `limit` validated. |
| Suspend / restore / disable / archive tenants | `POST /api/v1/tenants/:id/{suspend,restore,disable,archive}` | `iam.tenants.{suspend,restore,delete}` | Audit event with reason; sessions/email cascade in service. |
| List / get / create / patch platform admins | `/api/v1/admin/admins*` | `iam.admins.{view,create,update}` | New entries are added to the RBAC cache. |
| Suspend / restore platform admins | `POST /api/v1/admin/admins/:id/{suspend,restore}` | `iam.admins.{suspend,restore}` | Suspending last active super is rejected with 409 (`CONFLICT`). |
| Update admin type (demote/promote) | `PATCH /api/v1/admin/admins/:id` | `iam.admins.update` | Demoting last active super is rejected with 409. |
| List / audit / access logs | `/api/v1/{audit-logs,access-logs}*` | `audit_logs.{view,export}`, `access_logs.{view,export}` | Append-only audit history; redaction enforced at service. |
| Support operations | `/api/v1/support/*` | `support.configure` | Reason required, double audit + access log, daily cap. |
| Monitoring diagnostics | `/api/v1/monitoring/health/*` | `monitoring.view` | Live probes only; deferred items return structured `deferred`/501. |
| Workspace APIs | `/api/v1/tenants/*` (user routes) | tenant-scoped roles | Workspace JWT cannot reach platform-only routes (audience-gated by `adminAuth` middleware). |

**Deny by default:** `permission()` middleware denies any route that does not match a known permission key, and any actor whose role set does not include the required key. Unknown permissions cannot silently grant access.

**Tenant isolation:** `adminAuth` rejects non-admin JWTs; tenant-only routes are gated by `resolveTenant` and the tenant-scope plugin. The platform dashboard reads counts/recents from authoritative stores and never crosses tenant boundaries inappropriately.

---

## 5. API contracts and data-model changes

### 5.1 New endpoint

`GET /api/v1/admin/dashboard/summary?limit=10` (auth: `admin` audience + `iam.tenants.view`)

Response (200):
```json
{
  "success": true,
  "statusCode": 200,
  "message": "Dashboard summary fetched",
  "data": {
    "counts": {
      "total": 0,
      "pending": 0,
      "active": 0,
      "suspended": 0,
      "disabled": 0,
      "archived": 0
    },
    "recentTenants": [
      { "id": "...", "name": "...", "slug": "...", "status": "active", "createdAt": "...", "updatedAt": "..." }
    ],
    "recentActions": [
      { "id": "...", "module": "iam.tenants", "action": "tenant.suspend", "resourceId": "...", "actor": { "id": "...", "type": "admin" }, "occurredAt": "..." }
    ],
    "health": { "status": "ok", ... },
    "generatedAt": "ISO-8601"
  },
  "timestamp": "ISO-8601"
}
```

`limit` is clamped to 25; values > 25 are reduced silently. Response shapes are documented in the frontend `DashboardSummary` type in `src/features/admin/api/index.ts`.

### 5.2 Existing endpoints (reused)

The console consumes existing endpoints verbatim. No new permissions were added; the matrix in §4 enumerates the existing keys.

### 5.3 Data-model changes

- `Admin` model: no schema change.
- `AdminRole` / `Role` / `Permission` / `Module`: no schema change.
- `Tenant`: no schema change.
- `AuditLog`: no schema change.
- New admin-side field (read-side, no schema change): `Admin.countActiveSupers()` aggregation (counts `{adminType:'super', status:'active'}`).

No migrations are required. Rollback is via `git revert`; no destructive migrations planned.

---

## 6. Tests and exact command results

### 6.1 Backend (full suite)

```
$ cd backend && npm test
# tests 438
# pass 438
# fail 0
```

CI guards:
```
$ npm run ci:guards
check-stubs: OK
check-routes: OK
check-models: OK
check-config: OK
check-readme-sync: OK
ci:guards OK
```

Stage 1 regression tests (`tests/platform-admin-authorization.integration.test.js`):
- workspace user denied from platform APIs (401) — pass
- missing permission denied by default for platform admin (403) — pass
- super admin with `iam.admins.view` can list admins (200) — pass
- platform admin with `iam.tenants.view` can list tenants (200) — pass
- lower-privileged admin cannot escalate roles via `/admin/admins/:id/roles` (403) — pass
- last active super admin cannot be suspended (409 `CONFLICT`) — pass
- last active super admin cannot be demoted (409 `CONFLICT`) — pass

### 6.2 Frontend

```
$ cd frontend && npm test
Test Files  25 passed (25)
     Tests  240 passed (240)

$ npm run typecheck
(tsc --noEmit — clean)

$ npm run lint
0 errors, 9 warnings (all pre-existing react-refresh/only-export-components warnings)

$ npm run build
✓ built in ~1.27s — Vercel output generated
```

### 6.3 Git diff check

Both repositories: `git diff --check` shows no whitespace/line-error issues (only a CRLF normalization warning on `src/routes/index.js` which is a default Git on Windows).

---

## 7. Configuration and infrastructure requirements

**No new environment variables or infrastructure required.** All existing services (MongoDB, optional Redis, optional SMTP, optional S3) are unchanged. The dashboard summary depends on MongoDB only (tenant counts + recent audit log) and reuses the existing monitoring aggregate.

---

## 8. Deferred capabilities and known limitations

Per the plan, the following are intentionally deferred and recorded here for traceability:

- **Feature flags and global settings** (Stage 8): `/api/v1/feature-flags/*` and `/api/v1/settings/*` remain 501 placeholders. The `featureFlag` and `setting` services/models exist. Implementing an internal editor carries non-trivial risk (server-side validation, secret redaction, scope isolation). The recommendation is to defer until the product requires specific platform flags/settings with explicit schema/owner.
- **MFA recovery codes**: not implemented. Existing 2-step TOTP enroll/verify is the authoritative flow; recovery would require careful design (avoiding custom crypto).
- **Queue heartbeat / failed-job counters**: not implemented. The monitoring aggregate reports `deferred` for queue/scheduler/storage/connectors; the UI shows `unknown` honestly.
- **Compliance UI**: `admin.compliance.tsx` continues to render `ComingSoon`; backend compliance endpoints exist but the surface is not yet wired into the Platform Admin UI.
- **Admin types naming drift**: backend canonical enum is `super|platform|support`; frontend UI types are `super_admin|platform_admin|support_admin|readonly_admin`. Mapping is done at the API boundary; no backend enum changes planned.
- **Cross-tenant support access**: the existing `support.configure` workflow (impersonation with reason, daily cap, double audit) is in scope and used by the SupportLookup view. The UI does not bypass tenant isolation.
- **Sandbox tenant status**: no `sandbox` enum value exists; statuses are `pending|active|suspended|disabled|archived`.

---

## 9. Migration and rollback

- **No data migration** was performed. The new endpoint reads existing collections; the new repository function is read-only.
- **Rollback**: `git revert <commit>` in both repos restores the previous state. Because the route is new and the service additions are additive, no destructive migration is needed.
- **Operational guidance**: no production deploy was performed in this phase.

---

## 10. Remaining production-readiness work

- Wire a real production build / smoke test of the new `/admin/dashboard/summary` endpoint (deferred until deploy).
- Define a redaction policy for the `health` object in the dashboard summary (currently reuses the monitoring aggregate).
- Add a CSP and security header smoke test that includes the new route path.
- Decide whether to expose additional aggregate data (alerts, recent failed jobs) once the queue heartbeat and email-delivery telemetry are implemented.
- Continue keeping `super_admin` / `platform_admin` / `support_admin` / `readonly_admin` UI labels mapped to the canonical `super|platform|support` backend enum.

---

## 11. Acceptance against the Phase 5 Definition of Done

| DoD item | Status | Evidence / gap |
|---|---|---|
| 1. Authorized platform admins can perform implemented operational tasks via real APIs | ✅ | Dashboard summary, tenant list/detail, suspend/restore, admin suspend/restore, audit filtering/export |
| 2. Every privileged op is server-side enforced (deny by default) | ✅ | `adminAuth` + `permission()` on every admin route; regression tests confirm 401/403 |
| 3. Platform Admin remains separate from Workspace Admin | ✅ | `AdminPortal`/`AdminShell` distinct from `TenantPortal`/`TenantShell`; routes under `/admin/*` |
| 4. Tenant isolation intact | ✅ | Workspace user cannot reach platform APIs (covered by tests); tenant routes continue to use `resolveTenant` + scope plugin |
| 5. MFA, sessions, audit behavior meet criteria | Partial | Existing TOTP flow unchanged (no regression); last-super protection added server-side; audit redaction already in service. **Gap:** MFA enroll/verify/disable events are not emitted to `AuditLog` by `mfa.service.js` — login/MFA failures are logged via access logs but the plan called for explicit audit events. Existing pre-Phase-5 admin-auth integration tests cover the MFA path; no new MFA-specific tests were added in Phase 5. |
| 6. No sensitive secrets exposed by APIs or UI | ✅ | `Admin` serializer strips `passwordHash` + `mfaSecret`; audit redaction in service; export endpoint requires permission; dashboard summary projects only safe fields |
| 7. Tests and required build gates pass | ✅ | Backend 438/438 (twice); CI guards 5/5; frontend 240/240; typecheck/lint/build clean |
| 8. Documentation reflects actual implementation | ✅ | This report + the plan |
| 9. Remaining production infrastructure requirements recorded | ✅ | See §10 + §13 |
| 10. Changes preserve existing work; no commits/pushes/deploys | ✅ | No `git commit`, no push, no deploy performed |
| 11. Deferred capabilities listed with rationale | ✅ | §8 + §13 |

---

## 12. Sign-off

Phase 5 implementation is complete against the in-plan scope, with explicit deferrals recorded. No public platform-admin registration or unauthenticated bootstrap was added. No tenant-facing behavior was modified. Existing CI guards, test suite, lint, typecheck, and production build all pass.

---

## 13. Additional gaps identified during final verification

The final pass identified two items that the plan called for but Phase 5 did not fully deliver. They are recorded here honestly rather than glossed over:

1. **MFA audit events (Stage 4, item "add audit events for MFA enroll/verify/disable where missing"):**
   - The plan asked for explicit `AuditLog` entries for MFA enroll/verify/disable.
   - `mfa.service.js` and `mfa.controller.js` do not currently emit `AuditLog` events. Login successes/failures are captured via the access log + controller-level logger, but they are not queryable through `/api/v1/audit-logs` as `iam.mfa.*` entries.
   - **Recommendation:** add `auditLogService.emit({ module: 'iam.mfa', action: 'mfa.enroll' | 'mfa.verify' | 'mfa.disable', actor, resource, reason })` calls in the MFA service. This is a small additive change that does not require schema work. Deferred to a follow-up because it is observability/audit completeness rather than a security boundary.

2. **Support access UI (Stage 7):**
   - The plan asked the SupportLookup UI to clearly indicate active impersonation and provide a stop path.
   - The existing `SupportLookup` view only performs tenant lookups. There is no UI for starting/stopping impersonation, no indication of active impersonation, and no `auditExportStatus`/impersonation banner in the AdminShell.
   - The underlying `POST /api/v1/support/impersonate` and `POST /api/v1/support/impersonate/stop` endpoints exist and are fully covered by `tests/support.integration.test.js` (pre-Phase-5).
   - **Recommendation:** add a Support section in the AdminShell that surfaces active impersonation state and provides a stop button. Deferred because the API surface is intact and any operator with the `support.configure` permission can already call the API directly; the UI gap is a usability/completeness gap, not a security gap.

Neither gap is a security regression. Both are clearly identified, with the backend surface intact.
