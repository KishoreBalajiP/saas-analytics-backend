# Analivo Backend Audit Report

Audit date: 2026-10-15 (Asia/Calcutta)  
Scope: `backend/`, with frontend contract references where relevant  
Mode: read-only audit; no implementation changes were made

## Executive summary

The backend is a substantial Node.js 20+/Express 5/Mongoose 8 multi-tenant service with authentication, IAM/RBAC, tenant lifecycle, connectors, analytics, dashboards, reports, alerts, governance, billing, external API keys, and embeds. The repository is structurally healthy: both Git worktrees were clean, the five CI guards passed, and the backend test suite completed with 561 passing tests and no failures.

The audit does not establish production readiness. The strongest verified issue is documentation/status drift: `README.md` and `AI_CONTEXT.md` still describe Sprint 8/9 as planned or Sprint 7 as current, while `src/docs/STATUS.md` describes Sprints 0–9 as complete. The code and route surface contain Sprint 8/9 functionality, so the older documents are stale. There are also two moderate transitive dependency advisories through `exceljs` → `uuid`; remediation is available only through a breaking `exceljs` change and requires a separate compatibility review.

Security and tenant isolation have meaningful defense-in-depth controls—authentication, tenant resolution, permission middleware, tenant-scoped models/repositories, encrypted connector configuration, signed webhooks, API-key scopes, and embed-token checks—but static inspection and the existing suite cannot prove every object-level negative case, live external connector behavior, deployment configuration, or production infrastructure property. Those remain explicitly unverified.

Readiness assessment: suitable for the next controlled engineering phase, not certified production-ready. The recommended first repair phase is documentation/contract reconciliation plus targeted P1 security and tenant-isolation verification, followed by any verified fixes.

## Repository inventory and architecture

| Area | Evidence |
|---|---|
| Runtime/framework | Node.js `>=20`, ESM, Express 5 (`package.json`) |
| Persistence | MongoDB/Mongoose 8; 46 model files; shared plugins and repositories |
| Infrastructure | In-memory or Redis cache/queue, local or S3 storage, node-cron, Socket.IO |
| Security | Helmet, CORS, rate limiting, cookie parser, JWT via `jose`, Argon2id/scrypt test seam, AES-256-GCM encryption |
| Code organization | `src/config`, `middleware`, `routes`, `modules`, `services`, `repositories`, `models`, `connectors`, `jobs`, `queues`, `cache`, `storage`, `websocket` |
| Surface size | 36 route modules, 322 JavaScript source files, 67 backend test files, 86 Markdown documents |
| CI guards | Stubs, routes, models, config, and README synchronization guards all passed |
| Git state | Backend and frontend repositories clean on `main`, tracking `origin/main` |

Request lifecycle is assembled in `src/app.js`: request ID and access logging, security headers, compression, CORS, cookie/body parsing, Morgan logging, versioned API routes with rate limiting, 404 handling, and centralized errors. `src/server.js` owns process startup, database/Socket.IO/scheduler lifecycle, and shutdown. Feature routes generally follow `authenticate`/`adminAuth`, `resolveTenant`, permission, validation, controller, service, repository/model boundaries.

## Baseline verification

| Check | Result | Evidence/limitation |
|---|---|---|
| `npm test` | PASS: 561 tests, 0 failures, 0 skipped | Completed under the repository runner with isolated test environment; duration ~168.8 seconds |
| `npm run ci:guards` | PASS: 5/5 | All five guard scripts reported `OK` |
| `npm audit --omit=dev` | WARN: 2 moderate | Transitive `uuid` advisory under `exceljs`; forced fix would install breaking `exceljs@3.4.0` |
| Type-check | NOT AVAILABLE | No type-check script or TypeScript backend configuration in `backend/package.json` |
| Lint | NOT AVAILABLE | No lint script in `backend/package.json` |
| Build | NOT APPLICABLE/NOT DEFINED | No backend build script; runtime is direct ESM JavaScript |
| Production/live provider verification | BLOCKED/NOT RUN | No production connection or external side-effecting operation was authorized |

## Sprint status reconciliation

Static evidence confirms implementation exists for the major Sprint 0–9 areas, including route modules, services, models, validators, jobs, and tests. `src/docs/STATUS.md` is the current detailed status source and claims all ten sprints complete. `README.md` and `AI_CONTEXT.md` contain stale earlier-phase statements, including Sprint 8/9 planned language, Sprint 7 as current, and obsolete test/audit counts. This is a verified documentation defect, not proof that every feature is production-complete.

| Area | Evidence-backed status |
|---|---|
| Sprints 0–3 | Implemented auth, IAM/RBAC, tenant lifecycle, settings, feature flags, sessions, MFA, and shared infrastructure are present and covered by tests |
| Sprint 4 | Connector persistence, CSV/XLSX/MongoDB/webhook paths, encrypted config, sync, and webhook routes are present |
| Sprint 5 | Analytics, master data, query history, exports, and tenant-filtered aggregation are present |
| Sprint 6 | Dashboard/widget CRUD, lifecycle, sharing, execution, and caching are present |
| Sprint 7 | Reports, alerts, notifications, scheduling, and exports are present |
| Sprint 8 | Access logs, compliance, audit export, monitoring, and support routes/services are present |
| Sprint 9 | External API, API keys, embed tokens, public embed execution, and added connector providers are present |
| Phase 3 enterprise items | Explicitly future or unverified: KMS-managed keys, WebAuthn/passkeys, multi-region, SIEM forwarding, SSO/SCIM, and other roadmap items |

## Security and tenant-isolation assessment

Verified controls include:

- User/admin authentication middleware and separate portal flows.
- Refresh-token rotation and replay-family revocation covered by tests.
- Default-deny permission middleware and route guard CI checks.
- Tenant resolution based on authenticated context, with documented rejection of trusting a client tenant header as authority.
- Tenant-scoped models/plugins, repositories, analytics aggregation matching, and dashboard/widget execution checks.
- AES-GCM connector configuration encryption and credential redaction conventions.
- HMAC webhook verification, API-key scope checks, signed/short-lived embed tokens, rate limiting, and central error handling.

Remaining verification gaps:

- A systematic route-by-route matrix proving every object lookup, update, delete, export, cache key, job payload, and external API operation is tenant-scoped.
- Live connector SSRF/DNS/redirect/private-network behavior under production networking.
- Redis/BullMQ multi-process behavior, scheduler duplication, and failure recovery.
- Real S3, SMTP, Razorpay, MongoDB connector, and webhook-provider behavior.
- Production secret rotation, proxy trust, CORS allow-list, cookie deployment settings, and observability configuration.

## API, validation, and data-integrity assessment

The route surface is broad and generally uses explicit auth/tenant/permission middleware; the route guard passed. Validators exist across auth, IAM, tenants, connectors, analytics, dashboards, reports, alerts, billing, compliance, and external surfaces. Models use shared plugin conventions enforced by the model guard.

The audit did not find a safe basis to claim complete OpenAPI parity because no single authoritative OpenAPI artifact was identified in the inspected backend inventory. API contract gaps should therefore be tracked from actual route declarations, validators, controller responses, and frontend API contracts.

Potentially high-impact areas requiring focused follow-up include aggregation/query resource limits, connector URL validation and SSRF defenses, export bounds, background tenant context, idempotency under concurrent delivery, compound tenant-scoped uniqueness, and cache isolation. These are investigation targets unless a specific defect is reproduced.

## Operational and dependency assessment

The application has graceful lifecycle abstractions, health/monitoring routes, configurable providers, queue/scheduler modules, and CI guards. However, no type-check/lint gates exist, live infrastructure was not exercised, and the transitive `uuid` advisory remains unresolved. A dependency update must be evaluated against XLSX generation and the lockfile; do not run `npm audit fix --force` automatically.

## Overall limitations

This was a repository and local-test audit, not a production penetration test, deployment review, customer-data review, or live integration certification. Findings marked unverified or blocked must not be presented as confirmed vulnerabilities. No operational containment or production mutation was performed.

