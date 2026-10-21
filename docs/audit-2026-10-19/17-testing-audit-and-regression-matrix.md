# 17. Testing audit and regression matrix

**Audience:** engineers who own test strategy and CI for both repositories.

**Summary.** Both repositories have substantial suites that do real work: the backend boots the actual Express app against an in-memory MongoDB for about 25 integration files, and billing, authentication and dashboard rules are asserted in detail. But **nothing runs them automatically**: neither repository has CI, so "CI green" in the documentation describes a laptop ({{OPS:no-ci}}). The suites also miss exactly where the product is broken. No backend test touches API keys, the external API or embedding ({{API:no-tests}}). The frontend tests mock the transport with response shapes the backend never returns, so the permission gate and the analytics and dashboard shape defects pass every test ({{FE:tests-mocked}}). Quota tests move tenants to the `pro` plan, which hides the quota-consumption bug ({{BIL:quota-ops}}). On the audit machine (Node 26) the suites were not fully green: one backend and two frontend failures, all environment-dependent ({{TST:env-tests}}).

## 1. Baseline results (this audit, 2026-10-19)

| Check | Result |
|---|---|
| Backend `npm test` | 561 tests: 560 pass, 1 fail (`self-service-registration.integration.test.js:205`, concurrent same-slug registration returned 201 twice, because unique indexes are built asynchronously and not awaited) |
| Backend `npm run ci:guards` | 5/5 pass |
| Frontend `npm run typecheck` | pass |
| Frontend `npm run lint` | 0 errors, 9 warnings |
| Frontend `npm test` | 244 tests: 242 pass, 2 fail (`storeTenantSlug` localStorage tests; Node 26 exposes a native `localStorage` that shadows jsdom's) |
| Frontend `npm run build` | pass |

The committed test logs (2026-10-12, a Windows machine) show 499/501, 505/506 and 506/506 backend runs, so intermittent failures pre-date this audit.

## 2. Inventory by category

| Category | Status | Notes |
|---|---|---|
| Backend unit | **Implemented and verified** | ~30 files: utilities, validators, middleware with mocked services, connector parsers |
| Backend integration (real HTTP + in-memory MongoDB) | **Implemented but incompletely verified** | ~25 files via `tests/helpers/http.js` and `mongo.js`; auth, RBAC, tenants, connectors (CSV, webhook), dashboards, reports, alerts, notifications, billing, compliance, monitoring, support |
| Frontend unit/component | **Implemented but incompletely verified** | 27 files; 23 mock `@/lib/api/client` or feature API modules; route tests render pages with mocked shells, never a real router |
| Type check | Passes; not gated | |
| Lint | Passes with warnings; not gated; `no-unused-vars` disabled | |
| Build | Passes; not gated | |
| API contract tests | **Missing** | Frontend `types.ts` and backend responses are never compared |
| End-to-end (browser) | **Missing** | |
| Security tests | **Implemented but incompletely verified** | Headers, lockout, refresh-family revocation, webhook HMAC, Razorpay signatures; nothing for API keys, embed, SSRF, expression injection, or privilege escalation inside a plane |
| Tenant isolation | **Partially implemented** | Service-level checks for dashboards, widgets and engine; HTTP checks for dashboards and reports only. None for `/analytics`, `/connectors/:id`, `/alerts`, external API or embed. Many service tests use string tenant ids (`'tenant-a'`) rather than real ids |
| Performance / load | **Missing** | |
| Provider integration (SMTP, S3, Redis/BullMQ, Razorpay) | **Mocked or simulated** | Runner forces in-memory and no-op providers; Razorpay through an injected fake |
| Background jobs | **Partially implemented** | `runDue`/`evaluateDue` tested directly; `scheduler.js`, cron wiring and the stub jobs untested |
| Billing | **Implemented but incompletely verified** | Strong provider-boundary assertions (~80 tests); misses quota-on-update and free plan change |
| CI pipeline | **Missing** | No `.github/` in either repository |
| CI guard scripts | **Partially implemented** | Regex and file-existence checks; `check-routes` checks for an authentication keyword, not authorisation or tenant resolution, which is how `/api-keys` shipped without tenant context; the stub allow-list is stale |

## 3. Test quality

| Issue | Example | Effect |
|---|---|---|
| Mocks encode invented contracts | `frontend/src/features/analytics/api/index.test.ts`, `DashboardDetailView.test.tsx`, `ConnectorList.test.tsx` injects a permissions array | The three blocking frontend defects pass all tests |
| Placeholders asserted as success | `tests/monitoring.integration.test.js` asserts `status: 'deferred'` | Stubs count as passing coverage |
| Setup that hides defects | Quota tests upgrade tenants to `pro`; `platform-admin-authorization` test falls back to an anonymous 401 if its tenant login fixture fails | Real defects and broken fixtures pass |
| Misleading titles | `alert.routes.integration.test.js:55` "…and tenant isolation" makes no cross-tenant assertion | False sense of coverage |
| Shared state and timing | Files share database state; index builds not awaited; fixed `setTimeout` sleeps | Intermittent failures (the baseline failure is one) |
| Isolation leaks into the repository | `STORAGE_BASE_DIR` not overridden, so tests write artefacts into `backend/uploads/` despite the runner comment claiming a temp directory | Repository pollution; possible cross-run interference |
| Production paths untested | Default run uses scrypt instead of Argon2id and `NODE_ENV=development` | Production-only configuration (cookies, HSTS, error detail, `autoIndex: false`) never exercised |
| Missing role-level tests | No HTTP test logs in as a Viewer | Viewer write attempts unverified |

## 4. Regression matrix (brief §18.1)

Status legend: **Covered** (adequate test exists), **Partial** (some coverage or service-level only), **Gap** (capability exists, test missing), **Planned** (capability missing, so the test is planned, not failed), **Blocked** (capability broken, test cannot pass yet).

| # | Scenario | Capability today | Existing tests | Status | Test to add |
|---|---|---|---|---|---|
| 1 | User accesses another tenant's dataset | Enforced (engine tenant `$match`, ownership checks) | `dashboards/widget.service.test.js:77`, `dashboard.execution.test.js:117`, `analytics.engine.raw.test.js:35`, `dashboard.routes.integration.test.js:201` | **Partial** | HTTP tests for `/analytics?connectorIds=<foreign>`, `/connectors/:foreignId`, external API with a foreign dataset id |
| 2 | Tenant admin attempts a platform-admin action | Enforced (JWT audience) | `platform-admin-authorization.integration.test.js:99,151`, `middleware/auth.test.js:126` | **Covered** (fix the fixture fallback) | |
| 3 | Viewer modifies a dashboard | Enforced by `permission('dashboards', 'update')` | Only a role-less user is tested | **Gap** | Log in as seeded Viewer; PATCH/DELETE dashboard → 403 |
| 4 | Revoked API key reused | Check exists (`apiKey.service.js:167`) but keys cannot be created over HTTP | None | **Blocked** until key creation is fixed | Create → revoke → call external API → 401 `INVALID_API_KEY` |
| 5 | Embed token used outside its scope | Embed broken | None | **Blocked** | Token for dashboard A cannot read dashboard B or another tenant; origin and locked-filter checks after the redesign |
| 6 | Connector refresh fails midway | No run model; stale-job recovery dead | Only skipped invalid rows (`sync-engine.test.js:45`) | **Gap** | Fail persistence mid-batch; assert `failed` status, partial-row policy, and no wedged `running` after restart |
| 7 | Query exceeds a resource limit | Only the 200-row page clamp | None | **Planned** (limits missing) | Expression value rejected; `maxTimeMS` exceeded returns a typed error; group-cardinality cap |
| 8 | Registration partially succeeds | Compensating rollback exists (`auth.service.js:587-620`) | None injects a failure | **Gap** | Fail user insert after tenant insert; assert no orphan tenant and a retryable response |
| 9 | Registration retry meets an existing workspace | Unique slug, mapped to 409 | `self-service-registration.integration.test.js:205` (concurrent), `:351` | **Failing in baseline** (index timing) | Await index build in the harness; add a sequential retry by the same owner against their pending workspace |
| 10 | Verification email delivery fails | `verificationSent: false` reported truthfully | `:325` covers an unconfigured transport only | **Partial** | SMTP throw path; UI shows "not sent" and offers resend |
| 11 | AI response contains an invalid query | No AI | None | **Planned** | Validator rejects unknown fields/ops; one repair round then `unanswerable` |
| 12 | AI request references an unauthorised dataset | No AI | None | **Planned** | Planner choosing a foreign dataset is rejected by post-plan authorisation |
| 13 | Anomaly reported with insufficient history | Stub | None | **Planned** | Fewer than 7 points → "not enough history", no event |
| 14 | Two concurrent requests exceed a quota | Atomic increment with compensation | `entitlement.service.test.js:145-164` (12 concurrent, 5 succeed) | **Covered** at service level | HTTP-level concurrent creates; updates and deletes never consume quota |
| 15 | Administrator loses permission during a session | RBAC cache with version bump | `rbac/services.integration.test.js:213-235` (service) | **Partial** | Same live token gets 403 after role revocation over HTTP |
| 16 | Remove the last Super Administrator | Guard on suspend and demote | `platform-admin-authorization.integration.test.js:188-226` | **Covered** (single actor) | Concurrent demotion race; role revocation path |
| 17 | Background job executes twice | No claim or lock for reports and alerts | Idempotency tests for billing, connector replay, invitations | **Gap** | Two schedulers tick concurrently; exactly one report run and one alert event |
| 18 | Scheduler stops running | No heartbeat; probe is a placeholder | Monitoring test asserts `deferred` | **Planned** | Heartbeat stale → readiness degraded and alert |
| 19 | Tenant suspended while embed access remains | Not enforced | Suspension test covers sessions only (`tenants/tenant.integration.test.js:197`) | **Planned** | Suspend tenant → API key and embed requests refused |
| 20 | Deletion leaves related data behind | Dashboard → widgets cascade; connector rows not deleted; no tenant deletion | `dashboard.service.test.js:127`, `compliance.integration.test.js:194` | **Partial** | Connector delete removes rows and invalidates caches; tenant deletion purge report |

## 5. Recommended test strategy

1. **CI first** (roadmap 0.2): GitHub Actions (or the team's choice) running backend guards and tests on the pinned Node LTS, plus a second job with `test:argon2`; frontend typecheck, lint, tests and build. Required checks on `main`. Upload test reports as artefacts instead of committing logs.
2. **Fix harness isolation:** await `syncIndexes()` in the Mongo helper; per-file databases; `STORAGE_BASE_DIR` pointed at a temp directory; deterministic clocks instead of sleeps; pin a Node version where `localStorage` behaves as tests expect, or stub it explicitly.
3. **Contract tests:** generate frontend types from backend schemas or OpenAPI; add a small suite that runs the real backend and asserts response shapes for the main routes the frontend consumes.
4. **Authorisation matrix tests:** a table-driven HTTP suite that logs in as each seeded role (and as a user of another tenant) and calls every route, asserting allow/deny from document 05's matrix. This would have caught the API-key IDOR and the invitation escalation.
5. **End-to-end smoke tests** with Playwright on staging: register → verify (test mailbox) → upload CSV → query → dashboard renders → invite member; admin login with MFA; embed after the redesign. Include an axe accessibility check.
6. **Load tests** (k6 or similar) after Phase 1: CSV sync, dashboard with 30 widgets, concurrent analytics queries per tenant, two app instances.
7. **Provider tests in staging:** SMTP to a test inbox, Razorpay test mode with duplicate and out-of-order webhook replays, S3 bucket, Redis/BullMQ worker failover.
8. **AI evaluation harness** when AI work starts (document 08 §11), separate from unit tests.

## 6. Test-count reconciliation

Static count on the audited commits: 561 backend `test()` declarations and 239 frontend `it()/test()` declarations (vitest reports 244 because of generated cases). Documents in the repository quote 124, 367, 405, 533 and 561 for the backend and "12 files / 207 tests" for the frontend; none was produced by an automated run that can be inspected. Future reports should cite CI run links instead of numbers.

## 7. Findings in this area

{{OPS:no-ci}}, {{API:no-tests}}, {{FE:tests-mocked}}, {{TST:env-tests}}, {{TST:mocked-contracts}}, {{BIL:quota-ops}}. Other test-related items from the tests auditor (guard limitations, shared state, placeholder assertions, KDF and production-mode gaps, untested registration rollback) are listed under the `TST` prefix in `19-findings-register.md`.
