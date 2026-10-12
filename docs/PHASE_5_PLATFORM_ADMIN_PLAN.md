# Analivo Phase 5 — Platform Admin Console Plan

**Location:** `backend/docs/PHASE_5_PLATFORM_ADMIN_PLAN.md`  
**Date:** 2026-10-12  
**Status:** Planned  
**Owner:** Platform Engineering  

---

## 1. Purpose

This plan defines the audit, architecture, implementation, testing, and validation approach for an enterprise-grade internal Platform Admin console for Analivo. The console must operate entirely within existing security boundaries: reuse existing platform authentication/authorization, preserve tenant isolation, avoid weakening controls, and remain compatible with current backend/frontend contracts.  

---

## 2. References (authoritative)

- Backend: `D:\saas-analytics-platform\backend\src\` (models, middleware, routes, services, validators, utils)
- Frontend: `D:\saas-analytics-platform\frontend\src\` (routes, features/admin, lib/api, components)
- API Contract: `backend/src/docs/backend/frontend-api-contract.md` (frontend-facing contract; hand-transcribed types in `frontend/src/lib/api/types.ts` must stay in sync)
- RBAC/Auth: `backend/src/docs/backend/rbac.md`, `authentication.md`, `security.md`
- Phase reports: `backend/docs/PHASE_3_SECURITY_OPERATIONS_REPORT.md`, `PHASE_4_ONBOARDING_REPORT.md`
- Phases/sprints: `backend/src/docs/phases/phase-4.md`, `sprint-9.md`, etc.
- CI guards: `backend/package.json` (`ci:guards`, `ci:check-stubs`, `ci:check-routes`, `ci:check-models`, `ci:check-config`, `ci:check-readme-sync`)

---

## 3. Stage 0 — Audit Summary (what exists vs gaps)

### 3.1 Existing (confirmed)
- **Admin auth surface:** `src/routes/admin-auth.routes.js` — login, refresh, logout, `mfa/enroll`, `mfa/verify`, `me`, password forgot/reset. **Backend login is `POST /api/v1/admin-auth/login` (not `/admin/login`).** Frontend serves `/admin/login` and calls `loginAdmin`.
- **Admin model:** `src/models/Admin.js` — `ADMIN_TYPES = super|platform|support` (canonical backend). `ADMIN_STATUSES = pending|active|suspended|locked`. `tenantScope` exists for support escalation only.
- **RBAC:** `requireRole`, `requireAdminType`, `permission()` middleware; `Role`, `Permission`, `Module`, `AdminRole` models; permission key must be `<module_key>.<action>`.
- **Tenant model:** `src/models/Tenant.js` — `TENANT_STATUSES = pending|active|suspended|disabled|archived` (no `sandbox`). Invitations (`TenantInvitation`), email verification (`EmailVerificationToken`).
- **Audit/Access logs:** `AuditLog`, `AccessLog` models; `auditLog.service.js` with recursive redaction; `audit-log.routes.js`, `access-log.routes.js` (permission-gated).
- **Support:** `support.routes.js` + `support.service.js` — impersonation (reason required, daily cap), account recover/revoke-sessions, tenant lookups, broadcast.
- **Health/Monitoring:** `/health` (liveness), `/health/ready` (readiness; 503 if DB down). `monitoring.routes.js` has live probes; queue/scheduler/storage/connectors/metrics deferred/501.
- **Frontend admin UI:** Routes under `/admin/*` (login, dashboard, tenants, tenant detail, admins, roles, audit-logs, access-logs, compliance, monitoring, support). Admin views in `features/admin/components/AdminViews.tsx`. API uses `audience: "admin"`, in-memory tokens, single-flight refresh.
- **CI guards:** `ci:guards`, `ci:check-stubs`, `ci:check-routes`, `ci:check-models`, `ci:check-config`, `ci:check-readme-sync`.

### 3.2 Gaps (must address or explicitly defer)
- Feature flags & settings routes: 501 stubs though services implemented (defer or minimal secure subset).
- MFA recovery: none; enrollment 2-step (document gap; no unsafe shortcuts).
- Queue heartbeat/failed-job counters: missing (health must report `unknown`).
- Admin management UI: read-only (need secure provisioning with privilege escalation protections).
- Tenant lifecycle UI: suspend/restore only; backend supports more — only expose authorized actions.
- Compliance page: `ComingSoon` (treat as deferred unless concrete safe endpoints exist).
- Admin types naming drift: backend `super|platform|support` vs UI labels `super_admin|platform_admin|support_admin|readonly_admin` — map, do not change backend.
- No `/admin/login` backend route: keep separation; never add public bootstrap.
- Export/pagination filters for audit/access: basic in UI; need bounded filters/pagination/safe sorting.

---

## 4. Stage 1 — Platform Admin Authorization Foundation
- Preserve separate `/admin/login` (frontend) and existing tenant login. No second auth system.
- Canonical roles `super|platform|support` (backend); deny by default; explicit permissions per sensitive op.
- Workspace roles cannot access platform-only APIs; platform role must not grant unrestricted tenant data access.
- Regression tests for role escalation, unauthorized, cross-tenant, missing permissions. No public platform-admin registration/bootstrap/default passwords/auto prod admin creation.
- Verify `adminAuth`, `requireAdminType`, `permission()` on all admin routes; treat UX gating as non-authoritative.

**Acceptance:** every privileged endpoint requires `adminAuth` + explicit permission; workspace JWT cannot call platform endpoints; no public bootstrap endpoints added.

---

## 5. Stage 2 — Platform Admin Dashboard & Tenant Lifecycle
- **Dashboard:** total tenants by status, recent registrations (bounded), recent platform admin actions (bounded, from AuditLog), operational service status (reuse aggregate/ready; report `unknown` if unmeasurable).
- **Tenant management:** paginated list with search (name/slug) and status/period filters; safe detail (no secrets/tokens/creds); suspend/reactivate with reason+audit; never delete as suspension shortcut. Do not allow email verification/onboarding retries to reactivate admin-suspended tenants. Safe state transitions; handle concurrency.
- **API reuse:** existing tenant admin routes with `iam.tenants.<action>`; extend UI only as authorized.

**Acceptance:** server-side auth+scope enforced; params validated (422); secrets never exposed; audit events written for sensitive lifecycle changes.

---

## 6. Stage 3 — Platform Administrator Management
Reuse `admin.routes.js`/`admin.service.js`: list/get, create/provision (secure operator workflow), assign/revoke roles, suspend/restore, admin audit, revoke sessions on sensitive changes. 
Security: privilege escalation prevention (super-only for privileged role grants), last active `super` protection (block demotion/suspension leaving zero active supers), reauthentication/step-up where feasible, no plaintext passwords, no unauthenticated bootstrap (reuse CLI/bootstrap if needed), full audit.
Frontend: replace read-only list with permission-aware UI; disable actions violating last-super protection.

**Acceptance:** escalation attempts 403 + audited; last-super protection server-side; role changes trigger session revocation where applicable.

---

## 7. Stage 4 — MFA, Sessions, and Account Security
Preserve existing TOTP (enroll/verify; enabled only after confirm; secrets encrypted). No recovery codes exist — document as gap if recovery needed; avoid custom crypto. Rotating refresh tokens, revokeAll on password reset, generic auth errors, rate limits/lockout. 
Actions: verify MFA gates not bypassable, add audit events for MFA enroll/verify/disable if missing, align frontend flow to contract, add tests for enforcement/wrong code/session revocation/lockout.

**Acceptance:** direct API calls cannot bypass MFA; MFA events audited (no secrets); session lifecycle consistent.

---

## 8. Stage 5 — Audit and Security Center
AuditLog append-only with redaction; `audit-log.routes.js` and `access-log.routes.js` (permission-gated). Enforce platform-only access, pagination/bounded filters/safe sorting, bounded exports, preserve redaction, prevent recursive logging/volume spikes, include actor/action/target/timestamp/outcome/request/correlation id/reason. Frontend: enhance with bounded filters/pagination/safe sorting; never render redacted secrets.

**Acceptance:** non-platform roles cannot access (403); exports bounded and permissioned; no secrets displayed; redaction verified.

---

## 9. Stage 6 — Operational Health and Diagnostics
Reuse liveness/readiness and monitoring aggregate (probes live; queue/scheduler/storage/connectors/metrics deferred). Report `unknown` when unmeasurable (never fabricate healthy). No sensitive data exposed. Permission-gated diagnostics (`monitoring.view`), bounded queries, handle optional deps. If heartbeat/telemetry missing, document limitation — only add minimal mechanism if fits architecture.

**Acceptance:** no sensitive info leaked; optional deps reported unknown/unavailable; permission-gated access.

---

## 10. Stage 7 — Audited Support Access
Existing controlled workflow (impersonate with reason ≤500, stop, recover, revoke-sessions, lookups, broadcast); double audit + access log, daily cap, `impersonation` claims, audited end-to-end. Support role default read-only; cross-tenant access must be time-limited/narrow/scope-limited with full audit trail, visible indication when active, reliable expiry/revocation, no shared creds/silent impersonation. Do not bypass tenant isolation globally. If cannot safely extend beyond existing impersonation, implement safer read-only alternative and document deferred.

**Acceptance:** all support actions audited (grant/use/revoke); expiry/revocation reliable; no global isolation bypass.

---

## 11. Stage 8 — Feature Flags and Global Configuration
Models/services exist (FeatureFlag strategies, Setting with `isSecret`, platform/tenant scopes). Routes are 501 stubs. Require: clear owner/scope, server-side validation, documented effects, permission-controlled+audited, secrets never returned, tenant overrides cannot leak, confirmation for high-impact, no unrestricted DB/editor for arbitrary env vars. **Recommendation:** defer entirely (keep 501, show ComingSoon in UI) unless product explicitly requires specific platform flags now. If implemented, read-only first, then write with strict allowlists.

**Acceptance (if implemented):** writes permission-gated/validated/audited; secrets never returned; tenant scope enforced; high-impact ops confirmed.

---

## 12. Stage 9 — Frontend Quality and User Experience
Platform Admin separate from Workspace Admin. Permission-aware navigation (UX only; backend authoritative). Loading/empty/error/retry/success via shared components (`states.tsx`, `DataTable`, `sonner`). Prevent duplicate submissions; show server-confirmed outcomes; confirm high-impact actions. Pagination + bounded search. Unauthorized deep links fail safely. API types synced with backend contract; no mock data in production screens. Conventions: flat `admin.<name>.tsx` routes wrapped in `AdminPortal` + `PageHeader`, nav entry in `ADMIN_NAV` with `Permissions.*`, calls via `features/admin/api/index.ts` (audience admin), gating via `hasPermission`, errors via `ErrorState`.

**Acceptance:** `tsc --noEmit`, lint, production build pass; no unrelated redesigns; tenant-facing behavior unchanged.

---

## 13. Stage 10 — Testing and Release Validation

**Backend (minimum):** role matrix (permitted/forbidden per role), workspace user denied platform APIs, cross-tenant isolation, unauthorized role escalation, last-super protection, suspended-tenant state transitions, MFA enforcement + session revocation, audit creation + sensitive-field redaction, pagination/filtering/validation/error cases, health responses (healthy/unhealthy/unavailable/unconfigured), support access expiry/revocation (if implemented), feature flags scope/authorization (if implemented). Integration with `mongodb-memory-server`, Node `--test`.

**Frontend:** admin API module tests (exist), loading/empty/error/permission-denied states, route guards/shell behavior (anonymous deep link → redirect), high-impact confirmations, component tests for new/modified components.

**Required commands (after stabilization):** (1) `npm test` in backend twice sequentially (also `npm run test:argon2` if touching auth); (2) backend `npm run ci:guards` (5/5); (3) frontend `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`; (4) `git diff --check` in both repos.

**Validation:** distinguish pre-existing vs regressions (investigate; don’t weaken/skip); isolated test infra; no prod data changes; follow existing test patterns.

---

## 14. Data Model Changes, Migrations, Rollback
No schema changes anticipated for MVP. If additive fields needed, they must be backward-compatible/optional/indexed carefully. No destructive migrations planned. Rollback via git revert; preserve existing work; never force-push.

---

## 15. Risks, Dependencies, Operational Requirements
**Risks:** CI guards trip if modifying stubs; type naming drift (`super|platform|support` vs UI labels); MFA recovery gap; queue health unknown; last-super protection correctness; tenant suspension semantics. **Dependencies:** `mongodb-memory-server`, Redis/BullMQ optional, SMTP optional. **Operational:** no prod data changes, no secrets logged/exposed, rate limits preserved, bounded audit/access volume, no production deploy in this phase.

---

## 16. Ordered Implementation Stages (execution plan)

| Order | Stage | Focus | Exit criteria |
|---|---|---|---|
| 1 | Stage 0 | Audit complete (done). | Plan written. |
| 2 | Stage 1 | AuthZ foundation review + tests. | Permissions enforced server-side; workspace denied platform access; regression tests pass. |
| 3 | Stage 2 | Dashboard + tenant list/detail + suspend/restore with audit. | Real data, bounded, audited, secrets protected. |
| 4 | Stage 3 | Platform admin management UI + last-super protection. | Secure provisioning with escalation protection; session revocation. |
| 5 | Stage 4 | MFA/sessions review + audit coverage. | No bypass; MFA events audited; session lifecycle intact. |
| 6 | Stage 5 | Audit/Security center hardening. | Bounded queries, permissions enforced, exports safe. |
| 7 | Stage 6 | Health/monitoring truthfulness. | No fabricated healthy; handles optional deps; permission-gated. |
| 8 | Stage 7 | Support access within existing contract. | Audit trail complete; expiry/revocation verified. |
| 9 | Stage 8 | Feature flags/settings decision (defer recommended). | Decision documented; CI guards satisfied if changed. |
| 10 | Stage 9 | Frontend QA. | Typecheck/lint/build pass; conventions followed. |
| 11 | Stage 10 | Full validation. | All gates pass; no regressions. |

---

## 17. Definition of Done (Phase 5)

Phase 5 complete only when: (1) authorized platform admins can perform implemented tasks via real APIs; (2) every privileged op server-side enforced (deny by default); (3) Platform Admin separate from Workspace Admin; (4) tenant isolation intact; (5) MFA/sessions/audit meet criteria; (6) no secrets exposed; (7) all required tests/gates pass (backend ×2, CI guards, frontend tests/typecheck/lint/build); (8) docs reflect actual impl (this plan + final report); (9) remaining prod infra reqs recorded; (10) all changes preserve existing work; (11) deferred capabilities listed with rationale.

---

## 18. Next Steps

1. Create this plan at `backend/docs/PHASE_5_PLATFORM_ADMIN_PLAN.md` (done).  
2. Proceed to Stage 1 (authZ review + regression tests). Keep changes minimal and reviewable.  
3. After each stage, update `backend/docs/PHASE_5_PLATFORM_ADMIN_REPORT.md`.  
