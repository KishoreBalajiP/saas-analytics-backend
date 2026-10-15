# Analivo Codebase Discovery Report

**Inspection date:** 2026-10-16 (Asia/Calcutta)  
**Scope:** checked-out `backend` and `frontend` repositories under `D:\saas-analytics-platform`  
**Method:** source inspection, route/model/service tracing, repository tests, frontend typecheck/build, and documentation comparison. No application source, production data, deployments, or Git history was changed.

## Executive summary

Analivo is a fairly complete multi-tenant SaaS analytics application skeleton with substantial implemented backend behavior: Express 5, Mongoose/MongoDB, cookie/bearer sessions, tenant isolation middleware, RBAC, audit/access logging, dashboards/widgets, analytics execution, alerts, reports, API keys, embed tokens, billing/entitlements, admin operations, and connector ingestion. The frontend is a React 19/TanStack Router/Vite application with public, tenant, and platform-admin routes and feature clients for most of those surfaces.

The strongest verified area is backend behavior exercised against isolated in-memory MongoDB. The backend suite includes HTTP integration coverage for registration/authentication, access requests, admin MFA, tenant isolation/RBAC, dashboards, connectors, billing, audit/compliance, notifications, alerts, reports, monitoring, and refresh-token replay. The frontend suite passed 27 files and 244 tests; typecheck and production build were started and showed no errors in the captured output. Production behavior remains unverified.

The most important qualification is that the codebase intentionally mixes delivered features with fail-closed architectural placeholders. `backend/src/routes/settings.routes.js` explicitly returns `501`; `backend/src/utils/stubs.js`, `BaseConnector.js`, and job files document placeholder behavior. Google Sheets synchronization, email queue draining, cleanup/retention, anomaly detection, and parts of storage/cache/monitoring are not demonstrated as operational. The UI can therefore expose a much broader product surface than the external providers and background jobs can currently support.

**Release assessment: not production-ready based on repository evidence alone.** The code has meaningful tested foundations, but live email, real connectors, deployed-source parity, production configuration, payment-provider verification, scheduled jobs, browser production behavior, backups/recovery, and full end-to-end journeys remain unverified. React error #418 cannot be attributed from source inspection alone; browser-console verification is required.

## Repository and architecture map

| Area | Evidence | Finding |
|---|---|---|
| Backend repo | `backend/.git`, branch `main`, working tree clean at inspection | Node >=20, ESM, Express 5 |
| Frontend repo | `frontend/.git`, branch `main`, working tree clean at inspection | React 19, Vite 8, TanStack Router, TypeScript |
| Backend entry | `backend/src/server.js`, `backend/src/app.js` | Configures middleware, API prefix, routes, health/error handling, scheduler/socket lifecycle |
| Persistence | `backend/src/config/database.js`, `backend/src/models/*`, repositories | MongoDB/Mongoose; many tenant-scoped schemas and indexes |
| Auth | `src/modules/iam/auth`, `routes/auth.routes.js`, `admin-auth.routes.js`, `middleware/auth.middleware.js` | Separate user/admin portals, access/refresh sessions, hashed refresh tokens, Argon2/scrypt configuration, admin TOTP MFA |
| Authorization | `tenantIsolation.middleware.js`, `rbac.middleware.js`, `permission.middleware.js`, `modulePermission.middleware.js` | Backend permission enforcement is present on major privileged routes; frontend checks are not sufficient alone |
| Async work | `src/queues/*`, `src/jobs/*`, `src/config/scheduler.js` | Memory/BullMQ abstractions and workers exist; several jobs are explicit stubs |
| Frontend | `src/router.tsx`, `src/routes/*`, `src/features/*`, `src/lib/api/client.ts` | Public, tenant, admin, embed, billing, analytics, dataset and reporting surfaces |
| Deployment | `backend/Dockerfile`, `docker-compose.yml`, `frontend/vercel.json`, `VERCEL.md`, `.env.example` | Render/Vercel context is documented; actual deployed-source parity and production health were not established |

Request lifecycle is generally: frontend route/feature API client -> `/api/v1` -> Express middleware (request ID, access log, CORS, helmet, rate limits, auth/tenant/RBAC/permission/validation) -> controller -> service/repository/model -> response. Connector and analytics paths add encrypted connector configuration, provider/queue workers, dataset/row persistence, query execution, widget/dashboard persistence, and optional export/embed layers.

## Feature inventory

| Feature | Frontend evidence | Backend evidence | Persistence/provider | Tests | Actual status | Gaps |
|---|---|---|---|---|---|---|
| Public registration/workspace onboarding | `routes/register.tsx`, auth API, registration tests | auth services, tenant initialization, verification token routes/services | User, Tenant, token models; SMTP required for real delivery | frontend registration; `auth-flow.integration.test.js` | Implemented, not end-to-end verified in production | Real email/provider delivery and deployed wiring unknown |
| Login/logout/session restore | login routes, `lib/auth/session.tsx`, API client | auth/session services and refresh routes | Session model, cookies/JWT | auth-flow, password/session tests | Verified in isolated tests | Browser/prod cookie/CORS behavior unknown |
| Admin login and RBAC | `admin.login.tsx`, admin shell/views | `admin-auth.routes.js`, permission middleware, admin roles | Admin, Role, Permission, UserRole | admin auth/RBAC/platform authorization tests | Implemented, isolated path verified | Actual admin bootstrap/config and MFA enforcement in deployment unknown |
| Admin TOTP MFA | API client and admin surfaces | `mfa.service.js/controller.js`, `otplib`, encrypted secret path; login requires code when enabled | Admin encrypted `mfaSecret`, `mfaEnabled` | `admin-auth-mfa.integration.test.js` | Implemented, isolated path verified | Recovery codes, disable route exposure, browser UX and production key configuration need verification |
| Password reset/email verification | `login.forgot.tsx`, `login.reset.tsx`, register flow | token models/services, mail transport | Mongo token records, SMTP | auth/password tests | Implemented, isolated path verified | Real delivery/retry/status unknown |
| Request Access/invitations | `request-access.tsx`, admin access requests | access request and invitation routes/services | AccessRequest, TenantInvitation | access-request integration tests | Implemented, isolated path verified | No GET-by-id route is intentional/observed; external email handoff unknown |
| Tenant/member management | admin tenant routes/views; tenant shell | tenant lifecycle/settings/invitation services | Tenant/User/roles/settings | RBAC/tenant integration suites | Implemented, isolated path verified | Recovery/retention and production operations unknown |
| CSV/XLSX connectors | dataset routes, upload zone, connector views | connector service; `modules/connectors/csv`, `xlsx`; upload middleware | Connector, ConnectorRow; local/S3 storage | connector integration tests and frontend API tests | Implemented, isolated path verified | Large-file/performance and real storage verification pending |
| MongoDB connector | connector UI/API | `modules/connectors/mongodb`, queue and connector service | Encrypted credentials, synced rows | connector integration coverage | Implemented, not real-provider verified | SSRF/network boundary, DNS rebinding and real provider behavior need safe isolated tests |
| Google Sheets | dataset/UI documentation mentions it | registry/job references; `sheetSync.job.js` says stub/TODO | No demonstrated working provider path | no convincing real integration | Planned/stubbed | Sync job is explicit no-op |
| Webhook ingestion | connector model/docs, webhook route | raw-body HMAC verification and enqueue path | Connector/webhook event/rows | webhook-related backend coverage | Implemented, isolated path needs review | Replay/idempotency and external delivery behavior need further verification |
| Analytics/query execution | analytics route, QueryBuilder/Results | analytics controller/service/engine/cache/worker | AnalyticsQuery, ConnectorRow/cache | analytics unit/integration tests | Implemented, isolated path verified | Real source diversity, resource ceilings and long-running query behavior not production-verified |
| Dashboards/widgets | dashboard list/detail/editor and WidgetView | dashboard/widget routes/services/models | Dashboard, Widget | dashboard service/routes/execution tests | Implemented, isolated path verified | Export/share/embedded access and reload behavior need browser E2E evidence |
| Reports/alerts | report and alert routes/components | report/alert services/jobs | Report, AlertRule/Event | report/alert integration tests | Implemented, not scheduled-delivery verified | Email/report scheduling and anomaly job are not proven operational |
| API keys/external API | `api-keys.tsx`, feature API | API key service/middleware, external API routes | hashed secret/prefix, scopes, expiry | API-key/frontend tests | Implemented, isolated path verified | Rate-limit/consumer examples and leak audit need deployment verification |
| Embedding | `embed.tsx`, embed feature | embed service/token routes and CORS config | EmbedToken | embed API tests | Implemented, not browser/prod verified | `.env.example` includes `EMBED_CORS_ALLOW_ALL=true`; origin policy needs hardening/verification |
| Billing/plans/entitlements | billing/admin billing views | Razorpay adapter, subscriptions, plans, entitlements, webhook routes | Subscription, PaymentTransaction, history | billing/Razorpay/pricing tests | Implemented with provider disabled by default; isolated behavior verified | No live/test provider verification; webhook/reconciliation/idempotency operational proof absent |
| Settings/feature flags | admin/tenant settings surfaces | `settings.routes.js` uses `notImplemented` for listed endpoints | Setting/FeatureFlag models/services exist | no full working route evidence | Partially implemented / planned | Route shell is 501 despite models/services |
| Background retention/email/sheets/anomaly jobs | UI does not prove jobs | `jobs/email.job.js`, `sheetSync.job.js`, `cleanup.job.js`, `anomaly.job.js` explicitly stub | Scheduler/queues | job tests are mostly contracts/isolated | Mock/demo or planned | No-op jobs can create silent operational gaps |
| Monitoring/audit/compliance | admin monitoring/audit/compliance pages | monitoring/audit/access/compliance services/routes | AuditLog, AccessLog, ComplianceLog, exports | integration tests | Implemented, isolated path verified | Real alerting/retention/export storage and observability unknown |

## End-to-end journey findings

### Registration and verification

Frontend `register.tsx` calls the auth API and consumes a verification token; backend auth creates the tenant/user/token records and uses `emailVerification.service.js` plus mail transport. Isolated tests verify registration, token consumption, and the frontend only claims success when the backend reports email delivery. The missing proof is actual SMTP/provider delivery, retry behavior, bounce handling, and deployed environment configuration.

### Login, sessions, MFA, logout

There are distinct tenant and admin login contracts. `auth.service.js` resolves tenant identity before user lookup, issues access/refresh material, persists sessions, rotates refresh tokens, detects replay and revokes the family. Admin TOTP uses `otplib`; the secret is encrypted in the model/service path and MFA is checked before admin token issuance. Tests cover valid/invalid credentials, MFA enrollment/verification, refresh rotation/replay and session revocation. Tenant-user MFA is not found as a working flow; the documented frontend contract explicitly says it is not implemented.

### Request Access and approval

Anonymous submission is persisted and duplicate pending submissions are idempotent in integration tests. Platform-admin listing/approval/rejection is permission-gated and approval hands off to invitations. The test log also confirms there is no `GET /access-requests/:id` route; that is not a security failure by itself, but clients must use the list/decision contract.

### Connectors -> dataset -> query -> dashboard

CSV/XLSX and MongoDB code paths, encrypted config, connector rows, analytics engine, dashboard/widget persistence and execution are present and tested in isolated environments. The registry/base abstraction still contains fail-closed methods, and Google Sheets synchronization is explicitly a no-op. Real external database connectivity, SSRF defenses under provider redirects/DNS changes, performance ceilings, and browser persistence across reloads remain unverified.

### API keys and embedding

`ApiKey` stores a prefix and SHA-256 hash, showing the secret only at creation; routes and middleware provide tenant-facing authentication/scopes. Embed tokens have TTL configuration and UI/API surfaces. Server-side ownership checks are present in the architecture and covered in selected tests, but production CORS is risky because `.env.example` defaults `EMBED_CORS_ALLOW_ALL=true`; actual deployed value is unknown and must not be assumed safe.

### Billing

Razorpay integration, subscription lifecycle, plans, entitlements, overrides and reconciliation services exist. Tests cover pricing, adapter behavior, webhook-related contracts, entitlement enforcement and admin/owner actions. `RAZORPAY_ENABLED=false` is the example default; no live or provider-sandbox transaction was run. Payment credentials and webhook configuration are external dependencies.

## Security gap analysis

These are source-backed findings or explicit verification gaps, not claims that production is exploitable.

| ID | Severity | Finding/evidence | Impact/confidence | Remediation/regression test |
|---|---|---|---|---|
| SEC-001 | High | `backend/.env.example:117` documents `EMBED_CORS_ALLOW_ALL=true` | If enabled in production, embed tokens may be usable from unintended origins. Potential, high confidence in configuration risk; deployed value unknown. | Default deny; require explicit allowlist and origin-bound token tests. |
| SEC-002 | High | `jobs/email.job.js`, `sheetSync.job.js`, `cleanup.job.js`, `anomaly.job.js` log “stub - nothing to do” | Verification emails/queued mail, retention, sheet refresh and anomaly alerts can appear configured but never execute. Confirmed code gap. | Make unsupported jobs visibly disabled/501 and add execution/alerting tests. |
| SEC-003 | Medium | `routes/settings.routes.js:39-44` all use `notImplemented` while settings models/services/UI exist | Admin/tenant controls can be misleading and may fail at runtime; confirmed. | Align UI to 501 or implement route contract; add UI-to-API tests. |
| SEC-004 | Medium | Connector abstraction uses fail-closed base methods and provider docs advertise more than registry evidence proves | A connector may be selectable without a complete driver. Confirmed partial implementation; exploitability depends on route validation. | Enumerate registered drivers at startup and reject unsupported types; test every advertised type. |
| SEC-005 | Medium | Production readiness cannot be established from `.env.example`, tests, or source; external URLs were not probed | Missing/incorrect JWT, encryption, Mongo, SMTP, CORS, storage, Redis or Razorpay config could break security or availability. Unknown deployment confidence. | Safe staging configuration audit and health/readiness checks; never use production secrets in tests. |
| SEC-006 | Medium | Real connector outbound-network controls were not fully demonstrated from static inspection | SSRF, metadata access, DNS rebinding, redirect and TLS risks require provider-specific safe tests. Potential, medium confidence. | Use allow/deny policy, resolve/connect validation, redirect restrictions, TLS verification, timeout/row/memory limits; add isolated adversarial tests. |
| SEC-007 | Low | Frontend tests emit React `act(...)` warnings; production React #418 was not reproduced | Test fidelity/noise issue; not evidence of hydration mismatch. Confirmed warning, low confidence for production impact. | Run browser production build with console capture, SSR/hydration comparison and extension-disabled reproduction. |

Positive controls verified in source/tests include backend auth/RBAC/tenant checks, refresh-token replay revocation, password reset session revocation, hashed API keys, encrypted connector/MFA secrets, helmet/CORS/rate limiting middleware, validation, audit/access logging, and negative authorization tests. These controls still need staged/live configuration verification.

## UI/UX and API consistency gaps

The route inventory is broad: public policy/auth pages; tenant dashboard, onboarding, datasets/connectors, analytics, dashboards, reports, alerts, API keys, billing, notifications, profile/settings/security, invite acceptance and embed; admin login/dashboard/tenants/admins/roles/access requests/audit/access logs/compliance/monitoring/plans/subscriptions/entitlements/support. Feature components generally use explicit loading/error states and TanStack Query refetching.

The main UX risk is mismatch between visible surface and backend state: settings and some operational/provider features are documented as “Coming soon” or return 501, while generic navigation and feature clients make them look available. Frontend tests use extensive mocked API modules, so they prove component behavior and request contracts, not deployed integration. Accessibility/responsive behavior and the reported React #418 require actual browser testing; source inspection found no proof that a hydration mismatch is produced.

## Documentation discrepancy report

The repository contains phase reports that describe broad production readiness and delivered modules, but the current source still contains explicit stubs. `backend/src/docs/STATUS.md` itself is the most reliable corrective document: it distinguishes shipped, stubbed and planned work. Historical phase reports and README claims must therefore be treated as historical/architectural evidence, not proof of live functionality. The frontend backend contract also explicitly tells the UI to show “Coming soon” for settings, feature flags, email templates and some monitoring probes, which conflicts with any generic interpretation that every route is available.

## Tests and validation executed

| Command | Result |
|---|---|
| `frontend: npm test` | Passed: 27 test files, 244 tests. React `act(...)` warnings appeared in session/chart tests. |
| `backend: npm test` | Passed: 561 tests, 0 failures, 0 skipped, exit code 0. Isolated test fixtures; logs included expected stub/provider and shutdown messages. |
| `frontend: npm run typecheck` | Passed with no diagnostic output, exit code 0. |
| `frontend: npm run build` | Passed, exit code 0. Vercel/Nitro build emitted non-fatal module-level `use client` directive warnings. |

No production URL, live payment, real email, external database, deployment, migration, bootstrap, destructive script, or secret value was used.

## Unknowns requiring safe evidence

1. Whether Render/Vercel deployments match these Git checkouts.
2. Whether production SMTP, MongoDB, storage, Redis, scheduler and Razorpay configuration is valid.
3. Whether real CSV/XLSX/MongoDB/webhook integrations work at production scale.
4. Whether browser production frontend reproduces React #418, and which component/extension is involved.
5. Whether production CORS/embedding values restrict origins.
6. Whether backups, restore drills, retention jobs and alerting operate.
7. Whether scheduled jobs are enabled and monitored.
8. Whether API documentation/examples match every deployed route and schema.

## Prioritized roadmap

1. **Release gate and configuration:** capture final CI exit statuses; create a staging environment; verify Mongo readiness, CORS, cookies, encryption key, SMTP, storage, queue and health/readiness behavior without production mutation.
2. **Security/data integrity:** harden embed origin policy; complete safe connector outbound-network tests; verify tenant isolation across every resource/export/download; add rate-limit, replay, expiry and concurrency coverage.
3. **Authentication/onboarding:** verify real mail delivery and retries; finish any missing tenant-user MFA decision; test browser cookie/session restoration and invitation transitions.
4. **Connector/analytics core:** make advertised connector registry explicit; finish or hide Google Sheets and provider jobs; enforce query timeout/row/memory limits; test reload/export/embed with real staged data.
5. **Operations:** replace or clearly surface email, cleanup, anomaly and sheet-sync stubs; add job failure metrics, retries, dead-letter/recovery behavior and retention verification.
6. **Admin/tenant controls:** align settings UI with 501 or implement it; verify final-super-admin protections, tenant suspension/session cascade, audit exports and support operations.
7. **Billing/API/embedding:** verify Razorpay sandbox webhook signatures/idempotency/reconciliation; verify key scope/expiry/revocation and origin-bound embeds.
8. **Frontend quality:** browser E2E for major journeys, production console capture, React #418 reproduction, accessibility/responsive checks, and remove misleading controls.
9. **Documentation:** update README/phase reports from this evidence and keep a generated route/status inventory.

## Recommended next prompt for Claude

“Using `docs/ANALIVO_CODEBASE_DISCOVERY_REPORT.md` and the supporting reports, plan implementation only. Preserve current user changes. Start with the release/security gates, explicit stubs, tenant isolation and authentication/onboarding gaps. For each task cite the exact files/routes/tests, define acceptance criteria and regression tests, and separate code changes from staging configuration and human approval. Do not assume any feature is production-ready merely because a route or unit test exists.”
