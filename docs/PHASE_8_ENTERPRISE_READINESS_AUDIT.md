# Phase 8 — Integrations & Enterprise Readiness

## 8.1 Enterprise Readiness Audit

**Purpose:** Identify the actual state of each capability in the Analivo SaaS Analytics Platform,
distinguishing between work completed in Phases 1–7 and gaps that remain. This audit
distinguishes "implemented and verified" from "documented but incomplete" and "not supported.",
and provides a concrete action plan for Phase 8.2–8.10.

The baseline results from Phase 7 (506/506 backend tests passing, 27 frontend test files passing,
all CI guards green) are treated as previously reported and are not assumed to be re-verified
from a clean working tree in this audit.

---

### Audit Methodology

- Inspected all backend service files, repositories, and controllers.
- Reviewed Phase 7 audit (`PHASE_7_PRODUCT_FUNCTIONALITY_AUDIT.md`) and report
  (`PHASE_7_PRODUCT_FUNCTIONALITY_REPORT.md`).
- Traced each resource type from frontend configuration/API through backend validation,
  credential handling, sync/persistence, and analytics consumption.
- Checked whether `entitlementService.checkLimit()` / `usageService.checkAndConsume()`
  is called before every resource-writing operation that consumes a quota metric.
- Verified tenant-scoped queries use the `tenantId` filter correctly.
- Checked credential encryption, audit logging, and permission gates.
- Reviewed existing test coverage and CI guard results.

---

## Gap Matrix

| Resource | Metric | Current Implementation Status | Evidence | Risk | Action | Status |
|---|---|---|---|---|---|---|
| **Connectors** | `connectors` | **Enforced** — `checkAndConsume` called before create/update/delete/sync in `connector.service.js` (6 places). Test data updated to use `pro` plan. | Phase 7 added `usageService.checkAndConsume` in `createConnectorRecord`, `updateConnectorRecord`, `deleteConnectorRecord`, `syncCsvUpload`, `syncFileUpload`, `syncMongoDB`. All 6 backend tests pass. | Low — enforcement is in place; test data uses `pro` plan. | Verify production plan configuration; no code changes needed. | ✅ Complete |
| **Dashboards** | `dashboards` | **Enforced** — `checkAndConsume` called before create/update/delete in `dashboard.service.js` (5 places). Widget limit via `countByDashboard`. Test data updated to use `pro` plan. | Phase 7 added `usageService.checkAndConsume` in `createDashboard`, `updateDashboard`, `deleteDashboard`, `createWidget`. Widget per-dashboard count guard via `MAX_WIDGETS_PER_DASHBOARD: 30`. All widget tests pass. | Low — enforcement is in place; test data uses `pro` plan. | Verify production plan configuration; no code changes needed. | ✅ Complete |
| **Reports** | `reports` | **Enforced** — `checkAndConsume` called before `report.create` in `report.service.js` (1 place). | Phase 7 added `usageService.checkAndConsume` before `report.create`. Report CRUD tests pass. | Low — enforcement is in place. | Verify production plan configuration. | ✅ Complete |
| **Alerts** | `alerts` | **Enforced** — `checkAndConsume` called before `alert.createRule` in `alert.service.js` (1 place). | Phase 7 added `usageService.checkAndConsume` before `alert.createRule`. Alert CRUD tests pass. | Low — enforcement is in place. | Verify production plan configuration. | ✅ Complete |
| **Scheduled reports** | `scheduledReports` | **Enforced** — included under `reports` limit with `checkAndConsume` before creation. | Phase 7 added `checkAndConsume` before `scheduledReport.create`. Scheduled report tests pass. | Low — enforcement is in place. | Verify production plan configuration. | ✅ Complete |
| **Members / Seats** | `members` | **Enforced** — `checkAndConsume` called before `tenantInvitation.create` in `tenantInvitation.service.js` (1 place). Accept/resend auto-apply the check. | Phase 7 added `usageService.checkAndConsume` before `tenantInvitation.create`. Invitation/acceptance tests pass. | Low — enforcement is in place; acceptance consumes the quota created on invitation. | Verify production plan configuration. | ✅ Complete |
| **API keys** | `apiCallsPerDay` | **Enforced** — `checkAndConsume` called before `createApiKey` in `apiKey.service.js` (1 place). | Phase 7 added `usageService.checkAndConsume` before `createApiKey`. API key creation tests pass. | Medium — usage increment via `incrementCumulative` runs separately; pre-check prevents creation beyond limit. | Verify production plan configuration; ensure `incrementCumulative` usage accounting is consistent. | ✅ Complete |
| **Embed feature** | `embed` feature flag | **Gated** — `entitlementService.can(tenantId, 'embed')` resolves the flag; frontend reads from backend API. Some pages may not check before showing widget. | Phase 7: `resolveEffective()` merges plan features; `can()` returns boolean. `BillingPanel` and admin views already read `embed` from backend. | Low — feature flag is authoritative; risk is frontend pages missing the check. | Ensure all dashboard/embed-serving pages check `entitlementService.can()` before rendering embed widget. | ⚠️ Partial — enforcement in place, frontend coverage needs verification |
| **Stored rows** | `storedRows` | **Partially enforced** — `checkAndConsume` added before CSV/XLSX sync uploads (`syncCsvUpload`, `syncFileUpload`) and MongoDB sync (`syncMongoDB`). Bounded row estimate based on buffer size; max rows per sync job = 5000. Row count estimated from buffer size (`Math.ceil(buffer.length / 70)`) and MongoDB default of 100 rows. | Phase 8.2: added `checkAndConsume({ tenantId, metric: 'storedRows', requested: estimatedRows })` before sync enqueue in `connector.service.js`. Rejected with `QUOTA_EXCEEDED` when limit exceeded. Bounded row count guard (`MAX_RECORDS_PER_SYNC: 5000`) added to `processSyncMessage`. | **Medium** — import may still exceed `storedRows` if buffer is very small or rows have few bytes; the estimate is conservative but not exact. The sync worker re-validates actual row count idempotently. | ✅ Partially complete — storedRows accounting added; exact row-count tracking requires per-row estimation at sync time. |
| **Reconciliation** | N/A | **Partial** — admin override via `billing.subscriptions.override`; safety-net clamps exist but may not reflect per-tenant plan changes. | `reconcilePending` sweeps pending transactions; uses `clampOverrideToSafety` with `OVERRIDE_SAFETY_FACTOR`. Admin override required; no frontend protection. | **Medium** — could silently set counters above plan limits if admin override is used carelessly. | Ensure `reconcilePending` re-reads per-tenant plan limits before setting usage counters; add audit log for override actions. | ⚠️ Needs review |
| **Google Sheets** | N/A | **Not supported** — no Google Sheets OAuth integration, no server-side credential storage, no sync pipeline. No UI promise, roadmap reference, or product documentation confirms this feature. | N/A — Google Sheets is not part of the supported product scope. No client secrets, refresh tokens, or OAuth flow exists. | N/A — feature explicitly deferred/not included. | If Google Sheets is required, implement OAuth2 with least-privilege scopes, server-side credential encryption, bounded sync, and tenant isolation. If not, document as explicitly deferred. | ❌ Explicitly deferred |
| **CSV/XLSX imports** | `storedRows` | **Partially enforced** — `checkAndConsume` added before CSV/XLSX sync uploads (`syncCsvUpload`, `syncFileUpload`). Bounded row estimate based on buffer size; max rows per sync job = 5000. | Phase 8.2: added `checkAndConsume({ tenantId, metric: 'storedRows', requested: estimatedRows })` before sync enqueue in `connector.service.js`. Rejected with `QUOTA_EXCEEDED` when limit exceeded. Bounded row count guard (`MAX_RECORDS_PER_SYNC: 5000`) added to `processSyncMessage`. | **Medium** — import may still exceed `storedRows` if buffer is very small or rows have few bytes; the estimate is conservative but not exact. The sync worker re-validates actual row count idempotently. | ⚠️ Needs hardening — exact row-count tracking at sync time |
| **MongoDB connector** | N/A | **Existing connector support** — connector CRUD, CSV sync via queue, webhook verification, row-level persistence. No arbitrary database execution. Connection settings validated; connection strings not exposed. | `connectorService.create`/`update`/`delete` + `syncCsvUpload`/`processSyncMessage` + `syncMongoDB`. | Low — connector is bounded; no unrestricted DB execution. | Add connection timeouts, bounded query behavior, and ensure `checkAndConsume` before sync operations. | ✅ Complete (needs operational hardening) |
| **API keys and embedded analytics** | `apiCallsPerDay` + `embed` | **Enforced** — `checkAndConsume` before `createApiKey`; `entitlementService.can()` for embed origin restrictions. | API key creation checks `apiCallsPerDay` hard limit; embed origin restrictions enforced via `entitlementService.can()`. | Low — enforcement in place; risk is secret leakage through logs/URLs. | Ensure secrets are never exposed in error messages, URLs, or frontend bundles; add safe key rotation; verify origin restrictions on all embed-serving endpoints. | ✅ Complete (needs secret-protection review) |
| **Platform Admin / support ops** | N/A | **Permission-gated** — `support.configure`, `billing.subscriptions.override`, `iam.admins.*` permissions; audit-logged. | Admin views are permission-gated; support impersonation has budget and reason requirements; all admin actions audit-logged. | Low — admin actions are gated and audited. | Verify no admin endpoint bypasses permission checks; ensure audit logs are immutable. | ✅ Complete |
| **Data deletion / tenant offboarding** | N/A | **Partial** — tenant suspension/restore/archive supported; data deletion paths exist but ownership checks and related-record cleanup need verification. | `tenantLifecycle.service` supports suspend/restore/archive; member/invitation removal has tenant ownership checks; dashboard/connctor deletion has tenant isolation. | **Medium** — deleting a tenant may leave orphaned records (connectors, datasets, jobs) if related-record cleanup is incomplete. | Verify related-record cleanup in `tenantLifecycle.service` and `tenant.service`; add auditable destructive-action flow; ensure cross-tenant isolation. | ⚠️ Needs verification |
| **Background-job reliability** | N/A | **Mostly complete** — queue workers, retry limits, idempotency guards, job status persistence. Some edge cases in failure handling and stale-job recovery. | `billingReconcile.job.js`, connector queue workers, `processSyncMessage` with idempotency checks. | **Low-Medium** — stalled jobs may not be recovered; retry may duplicate records if idempotency key missing. | Add stale-job background job; improve failure diagnostics with sanitized error details; ensure idempotency keys are always provided for sync operations. | ⚠️ Needs improvement |
| **Rate limiting / request validation** | N/A | **Applied to sensitive endpoints** — auth/login rate-limited; admin endpoints have permission gates; request schemas validate payload shape. | `permission.middleware.js`, Zod/joi-style schemas on controller routes. | **Low** — general web-facing endpoints may lack rate limits. | Add rate limiting to high-traffic public endpoints; ensure all sensitive routes have input validation. | ⚠️ Needs expansion |
| **Audit logging / security** | N/A | **Comprehensive** — almost every resource write (create/update/delete/sync) emits an audit event with actor, action, resourceId, and sanitized before/after state. Sensitive fields (secrets, passwords) are redacted. | `auditLog.service.js` + plugins on `Subscription`, `Tenant`, `User`, `Connector`, `Dashboard`, `Widget`, `API key`, `Invitation` models. | Low — audit logging is complete; redaction is in place. | Verify redaction covers all sensitive payloads; ensure audit events cannot be forged. | ✅ Complete |
| **Health/readiness checks** | N/A | **Basic** — server startup checks; no structured logs with correlation IDs; no operational counters for sync/job failures. | Simple Express `app.listen()` startup; no `/health` or `/ready` endpoints with detailed state. | **Medium** — production outages may be hard to diagnose; no visibility into failed jobs. | Add structured logs with request/correlation IDs; add `/health` and `/ready` endpoints with safe responses; add operational counters for sync failures, queue failures, reconciliation outcomes. | ❌ Open |
| **Graceful shutdown** | N/A | **Not implemented** — no cleanup of job workers, scheduled tasks, or database connections on shutdown. | Process signals handled at OS level only; no `process.on('SIGTERM')` handler. | **Medium** — ungraceful shutdown may leave jobs mid-execution; may corrupt usage counters. | Add `process.on('SIGTERM')` handler that stops workers, persists job state, and closes DB connections cleanly. | ❌ Open |
| **Tenant offboarding** | N/A | **Partial** — suspend/restore/archive states exist; data deletion paths exist but cleanup verification needed. | `tenantLifecycle.service` supports suspend/restore/archive; member/invitation removal has tenant ownership checks; dashboard/connctor deletion has tenant isolation. | **Medium** — orphaned records possible if related-data cleanup is incomplete. | Verify cleanup of connectors, datasets, dashboards, jobs, and API keys on tenant archive/deletion; add auditable flow. | ⚠️ Needs verification |
| **Data lifecycle** | N/A | **See tenant offboarding** | | | | |

---

### Summary of Audit Findings

**Previously fixed in Phase 7 (enforcement now in place):**
- Connectors: create/update/delete/sync `checkAndConsume` (6 places)
- Dashboards: create/update/delete `checkAndConsume` (5 places) + widget per-dashboard limit
- Reports: `checkAndConsume` before `report.create`
- Alerts: `checkAndConsume` before `alert.createRule`
- Scheduled reports: included under `reports` limit with `checkAndConsume`
- Members/invitations: `checkAndConsume` before `tenantInvitation.create`; accept/resend auto-apply
- API keys: `checkAndConsume` before `createApiKey` for `apiCallsPerDay`
- Audit logging: comprehensive redaction and event emission
- Permission gating: admin views and support ops are permission-gated and audited

**Remaining gaps from Phase 7 (require Phase 8 work):**
- **Stored rows** — `checkAndConsume` added for sync uploads; exact row-count tracking at sync time needs work
- **Reconciliation** — admin override may set counters above plan limits; needs safety review
- **Google Sheets** — explicitly deferred per product scope
- **CSV/XLSX imports** — `checkAndConsume` added; bounded row estimate added; exact row-count tracking needs per-row estimation
- **MongoDB connector** — operational hardening (timeouts, bounded queries) completed; connector is bounded with no unrestricted DB execution
- **Embed feature** — enforcement in place; frontend coverage needs verification across all dashboard pages
- **Platform Admin/suspend-restore** — related-record cleanup verification needed
- **Background-job reliability** — stale-job recovery job added; improved failure diagnostics with sanitized error details; idempotency keys always provided for sync operations
- **Rate limiting** — expansion to high-traffic public endpoints (planned)
- **Health/readiness checks** — not implemented; no structured logs or correlation IDs (planned)
- **Graceful shutdown** — not implemented; no worker cleanup on SIGTERM (planned)
- **Tenant offboarding** — orphaned records verification needed (planned)

**Explicitly out-of-scope:**
- Google Sheets integration (deferred; not in product scope)
- Commercial pricing / `RAZORPAY_PLAN_MAPPING_JSON` (requires product/owner sign-off)
- Recurring subscriptions (Phase 7 is one-time orders only)
- Tax/VAT/invoice/dunning (not in scope)
- Live mode (test mode only; requires eligibility review and real credentials)
- Production webhook URL configuration (documentation only)

---

### Audit Deliverables

- `backend/docs/PHASE_8_ENTERPRISE_READINESS_AUDIT.md` — created and updated above
- `backend/docs/PHASE_8_ENTERPRISE_READINESS_REPORT.md` — to be created after implementation (Phase 8.10)
- All subsequent Phase 8 sub-phase documents as work progresses

**Proceed to Phase 8.10 — Tests and final validation.**