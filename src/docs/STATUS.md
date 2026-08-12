# Project Status

## Purpose

> **WHAT this is:** the single source of truth for *what is implemented
> today* and *what is promised for the future*.
> **WHY it exists:** so every engineer knows what they should be doing
> today without grepping Slack or chasing the team lead.
> **HOW to use it:** read the *Current Development* section at the top
> each morning; consult the matching table for the area you care about.
> **WHEN to update it:** at the close of every sprint, in the same
> commit that updates the CHANGELOG.
> **WHERE it lives:** `src/docs/STATUS.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Backend engineer** opening their first PR of the day | Reads *Current Development* to know what sprint is active and which item is unblocked. |
| **Tech lead** planning the next sprint | Reads *Sprint Log* + *Phase Status* to see what is done and what is queued. |
| **Product manager** communicating timing | Reads *What's Planned vs Future* to give honest estimates without grepping code. |
| **PR reviewer** | Reads *What Is Still a Stub (Fail-Closed)* to know which surfaces must NOT appear in a new real handler. |
| **New engineer** | Reads *Shipped / Stubbed / Planned* to understand the state of the codebase on day one. |
| **Interview candidate** | Reads *Current Development* + the *Shipped / Stubbed / Planned* tables to anchor their answers. |

## Current Status

> **Status:** `Maintained` — the file is updated as part of every sprint
> closure PR. The state it describes: Sprint 0 ✅, Sprint 1 ✅,
> Sprint 2 ✅, Sprint 3 ✅ (Multi-Tenancy), Sprint 4 ✅ (Connector
> Platform), Sprint 5 ✅ (Analytics Engine + Master Data), Sprint 6 ✅
> (Dashboards & Widgets), **Sprint 7 ✅ (Reports, Alerts, Notifications &
> Scheduling)**. Sprint 8–9 🕓 planned.
> **Sprint:** Sprint 7 — Reports, Alerts, Notifications & Scheduling (complete).
> **Owner:** Engineering team.
>
> Last updated: **Sprint 7 close** — see [CHANGELOG.md](../../CHANGELOG.md)
> at the repo root for the entry-by-entry record.

---

## 🚦 Current Development — Read This First

> **This is the section every engineer reads before starting work each
> day.** It answers the questions that decide what you should be doing
> right now.

| Question | Answer |
| --- | --- |
| **Current Phase** | Phase 2 — Implementation |
| **Current Sprint** | Sprint 7 — Reports, Alerts, Notifications & Scheduling (✅ implemented). Sprints 0–7 complete; Sprints 8–9 planned. |
| **Current Goal** | Sprint 7 ships tenant-scoped scheduled reports (JSON/CSV/XLSX via the real analytics engine, off the HTTP hot path), threshold-based alerts evaluated through the same engine (event history + cooldown/dedup + notification dispatch), and the user-facing notification inbox — all behind existing `reports.*` / `alerts.*` / `notifications.*` RBAC with `resolveTenant` isolation. |
| **Current Progress (%)** | **~80 %** of Phase 2 complete. Sprints 0–1 (foundation + auth), Sprints 2–3 (IAM + multi-tenancy), Sprint 4 (connectors), Sprint 5 (analytics engine + master data), Sprint 6 (dashboards) and Sprint 7 (reports/alerts/notifications/scheduling) are the eight finished sprints of ten. |
| **Last Completed Milestone** | Sprint 7 close — reports (CRUD + scheduled run + JSON/CSV/XLSX export + history), alerts (CRUD + real-engine evaluation + events + cooldown + notifications), notifications inbox (list/read/delete/preferences). 367 tests pass, CI green, `npm audit` clean. See [Sprint 7](./phases/sprint-7.md). |
| **Next Deliverable** | Sprint 8 — Monitoring + Support (🕓 planned). |
| **Current Blockers** | **None known.** 367 tests pass, CI green, `npm audit` clean. |
| **Definition of Done (current sprint)** | ✅ All deliverables merged, 367 tests green, CI green (5/5), `npm audit` 0 vulnerabilities, status docs updated. |
| **Last Updated** | Sprint 7 close. This file is updated as part of every sprint closure PR. |

### What You Should Be Doing Right Now

| If you are… | Do this |
| --- | --- |
| **About to start Sprint 8** | Read [Sprint 8 plan](./phases/sprint-8.md) end-to-end, then the monitoring/support module READMEs. Sprint 8 also picks up the originally-planned Governance surfaces from Sprint 7 (`/access-logs/*`, `/compliance/*`, the `AuditLog` consumer) and the scheduler tick for `runDue` / `evaluateDue`. Open the sprint branch. |
| **Reviewing a PR** | Run `npm run ci:guards` and `npm test` locally. Check that any new route has an auth middleware (CI guard will flag it). Check that the matching entry in `STATUS.md` was updated. |
| **Debugging a flaky test** | Run the affected file with `node scripts/ci/run-tests.js tests/<path>.test.js` (this sets `PASSWORD_KDF=scrypt`, portable on Windows). Tests use `mongodb-memory-server`; the first run downloads a MongoDB binary (~80 MB). `npm run test:argon2` exercises the real Argon2id KDF on CI (Linux). |
| **Looking up an architectural rule** | The rule lives in the repo-root `README.md` (Architecture Rules) and in [`ARCHITECTURE.md`](./ARCHITECTURE.md); it is enforced by a CI guard under `scripts/ci/`. |
| **Reporting status** | Cite this file. Do not paraphrase "what's done" — copy the row from the relevant table. |

### Daily-Read Checklist

Before opening your first PR of the day, confirm:

- [ ] I am working on the sprint named under *Current Sprint* above.
- [ ] The file I am about to change is not on the [stub allowlist](../../scripts/ci/stubs-allowlist.js) (otherwise I am replacing a stub, which is welcome).
- [ ] If I added a new route, it has an auth middleware or an explicit `ci:routes-exempt` annotation.
- [ ] If I added a new Mongoose model, it applies at least one plugin from `src/models/plugins/`.
- [ ] If I touched `src/config/env.js`, `.env.example` was updated.
- [ ] If I changed behaviour described in any doc, that doc was updated in the same PR.
- [ ] `npm run ci:guards` passes locally.
- [ ] `npm test` passes locally.
- [ ] If this PR closes a sprint, this `STATUS.md` was updated.

---

## At a Glance

| Field | Value |
| --- | --- |
| **Phase** | Phase 2 — Implementation |
| **Current sprint** | Sprint 7 — Reports, Alerts, Notifications & Scheduling (✅ complete) |
| **Next sprint** | Sprint 8 — Monitoring + Support (🕓 planned) |
| **Repository version** | `1.0.0` |
| **Tests** | 367 pass, 0 fail |
| **CI guards** | 5 / 5 green |
| **`npm audit`** | 0 vulnerabilities |
| **Production features shipped** | 10 of ~30 (auth, IAM, multi-tenancy, connectors, analytics engine, master data, dashboards, reports, alerts, notifications) |

---

## Status Legend

Every row below carries one of these labels so a reader never has to
guess what is real:

| Label | Meaning |
| --- | --- |
| ✅ **Implemented** | Code is in the repo, tested, and the docs describe what it actually does. |
| 🟡 **Partial** | Some surface area shipped; the rest is scheduled. The doc names both. |
| ⛔ **Stub (fail-closed)** | Returns `501 Not Implemented` until the sprint that implements it lands. Listed in the [`scripts/ci/stubs-allowlist.js`](../../scripts/ci/stubs-allowlist.js). |
| 🕓 **Planned** | Scheduled in a sprint; design is firm; not yet implemented. |
| 🔮 **Future** | Discussed, not scheduled. Cannot be cited as a deliverable. |

---

## Milestone Tracker

```
Phase 1.x  ✅ ── Architecture locked (Express / Mongoose / Socket.IO /
                 Pino / Helmet / rate-limit / connector framework /
                 error envelope / WS rooms / scheduler / validators /
                 queue + storage + cache + encryption *contracts*).
                 Every business endpoint returns 501.

Sprint 0   ✅ ── Shared implementation foundation.
                 Real utilities (jwt, password, encryption, id,
                 idempotency). Real cache (memory + Redis). Real
                 queue (in-memory + BullMQ). Real storage (local +
                 S3). Real email transport. Real Mongoose plugin set
                 (tenantScope, softDelete, paginate,
                 optimisticConcurrency, audit). Real idempotency
                 middleware. Real CI guardrails. 73 tests pass.

Sprint 1   ✅ ── Authentication for both portals.
                 Real User / Admin / Tenant / Session / LoginAttempt
                 models + repositories. Real auth service (login /
                 refresh / logout / password reset), TOTP MFA for
                 super_admin, account lockout, refresh-token rotation
                 with family revocation. Real authenticate / adminAuth /
                 resolveTenant middleware. Real /auth/* and
                 /admin-auth/* routes. KDF seam (Argon2id / scrypt).
                 124 tests pass incl. end-to-end integration.

Sprint 2   ✅ ── IAM: admins, tenants, users lifecycle + RBAC.
                 Real Module / Permission / Role / RolePermission /
                 UserRole / AdminRole models. Real permission + role
                 services, permission/admin/tenant middleware. Real
                 /roles, /permissions, /admin/admins, /audit-logs,
                 /users, /tenants/:id/users routes. System roles seeded.
                 218 tests pass.

Sprint 3   ✅ ── Multi-Tenancy: tenant lifecycle + onboarding +
                 auth gate + tenant settings + feature flags.
                 Real Tenant / Setting / FeatureFlag models. Tenant,
                 tenantInitialization, tenantLifecycle, tenantSettings,
                 tenantStatistics, setting and featureFlag services.
                 Admin-gated /api/v1/tenants/*; login/refresh tenant-
                 status gate. Session + RBAC-cache cascade on lifecycle.
                 Effective settings inheritance + secret redaction +
                 read-only protection; per-key cache invalidation.
                 Feature-flag catalogue + per-tenant rollout. 232 tests
                 pass.

Sprint 4   ✅ ── Connector Platform: persisted, tenant-scoped
                 connectors + the CSV and inbound Webhook providers.
                 Real Connector / ConnectorRow models (config encrypted
                 at rest, webhook token sparse-unique, idempotent rows).
                 Real connector/connectorRow repositories + connector
                 service + csv/webhook/shared connector modules + sync
                 engine + connector queue consumer. Real /connectors/*
                 and /webhooks/* surfaces behind authenticate +
                 resolveTenant + permission('connectors', ...).
                 CSV upload + stream-parse ingest, HMAC-SHA256 webhook
                 verification. 285 tests pass.

Sprint 5   ✅ ── Analytics Engine + Master Data: tenant-scoped read
                 engine over ingested connector rows, query history +
                 async exports, and the global reference-data
                 catalogue. Real AnalyticsQuery / MasterData models,
                 analytics.engine.js (grouping, metrics, filters, date
                 presets, pagination, projection) + analytics.service/
                 cache, masterData.service with admin write / public
                 cached read. Real /analytics/* + /master-data/*
                 surfaces. 325 tests pass.

Sprint 6   ✅ ── Dashboards & Widgets: tenant-scoped dashboard +
                 widget authoring and widget analytics execution over
                 the analytics engine. Real Dashboard / Widget models.
                 dashboard.service (CRUD, publish, duplicate, share,
                 soft-delete) + widget.service (six types: kpi, table,
                 bar, line, area, pie) + executeWidget / viewDashboard
                 with date presets + per-query caching + cache bust on
                 edit + fail-closed execution (404 unknown
                 dashboard/widget, 400 foreign/deleted dataset). Real
                 /dashboards/* surface behind authenticate +
                 resolveTenant + permission('dashboards', ...); running
                 a widget additionally requires analytics.view. 367
                 tests pass (353 through Sprint 6 + 14 in Sprint 7).

…          ── Sprints 7 → 9: see [Sprint Log](#sprint-log).

Phase 3+   🔮 ── Enterprise: KMS, WebAuthn, multi-region, SIEM,
                 hash-chain audit, cold archival, PDF/XLSX
                 reports, Google Sheets connector, MongoDB
                 connector, OAuth/SAML SSO, SCIM 2.0.
```

---

## Phase Status

| Phase | Name | Status | Output |
| --- | --- | --- | --- |
| 1 | Production Backend Foundation | ✅ Implemented | `app.js`, `server.js`, `config/`, error envelope, request id, rate limiter, validators, websocket bootstrap, scheduler, queue + storage + cache + encryption contracts |
| 1.1 | Connector & Infrastructure Architecture | ✅ Implemented | `connectors/BaseConnector`, registry, fail-closed driver stubs |
| 1.2 | Platform Management Architecture | ✅ Implemented | All route shells + middleware stubs returning 501 |
| 2 | Implementation (Sprints 0–9) | 🟡 Partial | Sprints 0–6 complete (auth, IAM, multi-tenancy, connectors, analytics, dashboards); Sprints 7–9 planned |
| 3 | Enterprise Features | 🔮 Future | KMS, WebAuthn, multi-region, SIEM |
| 4 | (reserved) | 🔮 Future | |
| 5 | (reserved) | 🔮 Future | |
| 6 | (reserved) | 🔮 Future | |
| 7 | (reserved) | 🔮 Future | |

Detailed per-phase plans live under [`phases/`](./phases/README.md).
Detailed per-sprint plans live under
[`phases/sprint-N.md`](./phases/README.md#sprint-log).

---

## Sprint Log

| Sprint | Scope | Status | Tests Added |
| --- | --- | --- | --- |
| [Sprint 0](./phases/sprint-0.md) | Shared implementation foundation (utilities, cache, queue, storage, email, plugins, idempotency, CI) | ✅ **Complete** | 73 |
| [Sprint 1](./phases/sprint-1.md) | Authentication (User, Admin, MFA, refresh) | ✅ **Complete** | 51 (124 total) |
| [Sprint 2](./phases/sprint-2.md) | IAM (admins, tenants, users, RBAC, audit) | ✅ **Complete** | 94 (218 total) |
| [Sprint 3](./phases/sprint-3.md) | Multi-Tenancy (tenant lifecycle, onboarding, auth gate, settings, feature flags) | ✅ **Complete** | 23 (232 total) |
| [Sprint 4](./phases/sprint-4.md) | Connector Platform (CSV + Webhook connectors, sync engine, inbound webhook surface) | ✅ **Complete** | 53 (285 total) |
| [Sprint 5](./phases/sprint-5.md) | Analytics Engine + Master Data (query engine, query history, exports, reference catalogue) | ✅ **Complete** | 40 (325 total) |
| [Sprint 6](./phases/sprint-6.md) | Dashboards & Widgets (authoring, lifecycle, sharing, execution, cache) | ✅ **Complete** | 28 (353 total) |
| [Sprint 7](./phases/sprint-7.md) | Reports, Alerts, Notifications & Scheduling (scheduled report generation via the real analytics engine + JSON/CSV/XLSX export, threshold alerts evaluated through the engine with event history + cooldown + notification dispatch, notification inbox, tenant-scoped scheduling) | ✅ **Complete** | 14 (367 total) |
| [Sprint 8](./phases/sprint-8.md) | Monitoring + Support | 🕓 Planned | — |
| [Sprint 9](./phases/sprint-9.md) | Analytics + Embed | 🕓 Planned | — |

> **Sprint re-scope note:** the plan documents for Sprints 5–6 predate the
> delivery. Sprint 5 shipped the **Analytics Engine + Master Data** (the
> settings/feature-flags/notifications surfaces listed in the old plan
> stayed fail-closed stubs at the time; settings + feature flags themselves
> already shipped inside Sprint 3's `/tenants/*` surface). Sprint 6 shipped
> **Dashboards & Widgets**, not Master Data — Master Data moved earlier
> (Sprint 5) once the analytics engine existed to consume it. Sprint 7 then
> delivered **Reports, Alerts, Notifications & Scheduling** — the
> notifications surface is now fully implemented (in-app inbox + preferences,
> tenant/actor-scoped), and reports + alerts run on the real analytics
> engine. The `sprint-*.md` plan files are the source of truth for *planned*
> scope; this log records *delivered* scope.

---

## What Is Shipped Today

The following exist as production-grade code, not as stubs. Every bullet
links to the canonical documentation.

### Utilities

| Component | Implementation | Docs |
| --- | --- | --- |
| JWT signing & verification | [`src/utils/jwt.js`](../../src/utils/jwt.js) — `jose`, audience + issuer aware, typed `JwtError` | [`DECISIONS.md` ADR-001](./DECISIONS.md#adr-001-adopt-jose-over-jsonwebtoken-for-jwt) |
| Password hashing | [`src/utils/password.js`](../../src/utils/password.js) — Argon2id (default) with `PASSWORD_KDF=scrypt` portable test fallback; self-describing PHC hashes | [`DECISIONS.md` ADR-002](./DECISIONS.md#adr-002-argon2id-for-password-hashing) |
| ID generation | [`src/utils/id.js`](../../src/utils/id.js) — UUIDv4 + monotonic ULID + prefixed IDs + URL-safe tokens | [`DECISIONS.md`](./DECISIONS.md) |
| Encryption | [`src/utils/encryption.js`](../../src/utils/encryption.js) — AES-256-GCM, versioned envelope, context-scoped keys | [`DECISIONS.md` ADR-006](./DECISIONS.md#adr-006-aes-256-gcm-with-versioned-envelope-for-at-rest-encryption) |
| Idempotency | [`src/utils/idempotency.js`](../../src/utils/idempotency.js) + [`src/middleware/idempotency.middleware.js`](../../src/middleware/idempotency.middleware.js) | [`DECISIONS.md` ADR-008](./DECISIONS.md#adr-008-idempotency-middleware-with-cached-outcomes) |

### Infrastructure Drivers

| Layer | Providers | Public Service | Docs |
| --- | --- | --- | --- |
| Cache | memory, Redis (`ioredis`) | [`src/services/cache.service.js`](../../src/services/cache.service.js) | [`DECISIONS.md` ADR-003](./DECISIONS.md#adr-003-in-memory-cache-default-redis-when-redis_url-is-set), [`backend/cache.md`](./backend/cache.md) |
| Queue | in-memory, BullMQ | [`src/services/queue.service.js`](../../src/services/queue.service.js) | [`DECISIONS.md` ADR-004](./DECISIONS.md#adr-004-bullmq-for-durable-queue-transport), [`backend/queues.md`](./backend/queues.md) |
| Storage | local, S3 | [`src/services/storage.service.js`](../../src/services/storage.service.js) | [`DECISIONS.md` ADR-005](./DECISIONS.md#adr-005-s3-compatible-storage-abstraction), [`backend/storage.md`](./backend/storage.md) |
| Email | SMTP, noop | [`src/services/email.service.js`](../../src/services/email.service.js) | [`backend/... (planned)`](./backend/README.md) |

### Mongoose Plugin Set

All five live under [`src/models/plugins/`](../../src/models/plugins/) with
a single barrel export. CI guard
[`check-models`](../../scripts/ci/check-models.js) enforces that every
new model applies at least one.

| Plugin | Purpose | Docs |
| --- | --- | --- |
| `tenantScope` | auto-inject `tenantId` on reads; refuse to save without one | [`models/plugins/README.md`](../../src/models/plugins/README.md) |
| `softDelete` | `deletedAt` / `deletedBy`; auto-filter reads; `restore()` | [`models/plugins/README.md`](../../src/models/plugins/README.md) |
| `paginate` | `mongoose-paginate-v2` wrapper with platform defaults | [`models/plugins/README.md`](../../src/models/plugins/README.md) |
| `optimisticConcurrency` | `mongoose-update-if-current` (`__v`) | [`models/plugins/README.md`](../../src/models/plugins/README.md) |
| `audit` | EventEmitter domain events for Sprint 7 consumer | [`models/plugins/README.md`](../../src/models/plugins/README.md) |

See [`DECISIONS.md` ADR-007](./DECISIONS.md#adr-007-five-shared-mongoose-plugins).

### Shared Middleware

| Middleware | Status | Note |
| --- | --- | --- |
| [`idempotency`](../../src/middleware/idempotency.middleware.js) | ✅ Implemented | Cached outcome replay + in-flight coalescing + fail-closed |
| [`authenticate`, `optionalAuthenticate`](../../src/middleware/auth.middleware.js) | ✅ Implemented | JWT verify + session liveness check |
| [`authorize`](../../src/middleware/auth.middleware.js) | ✅ Implemented | Dynamic RBAC; default-deny via `permission` middleware (Sprint 2) |
| [`adminAuth`, `adminAuthOptional`](../../src/middleware/adminAuth.middleware.js) | ✅ Implemented | JWT verify + MFA-aware admin sessions |
| [`resolveTenant`](../../src/middleware/tenant.middleware.js) | ✅ Implemented | `X-Tenant-Id` header → JWT `tenantId` claim (subdomain parser is Phase 4+) |
| [`tenantIsolation`](../../src/middleware/tenantIsolation.middleware.js) | ✅ Implemented | Cross-tenant header/JWT scope guard (Sprint 2) |
| [`permission`, `denyIf`](../../src/middleware/permission.middleware.js) | ✅ Implemented | `<module>.<action>` guard, cached 60s, invalidated on write (Sprint 2) |
| [`audit`, `accessLog`](../../src/middleware/) | ⛔ Fail-closed stubs | Sprint 7 |
| [`compliance.*`](../../src/middleware/compliance.middleware.js) | ⛔ Fail-closed stub | Sprint 7 |

### Authentication (Sprint 1)

| Component | Implementation | Docs |
| --- | --- | --- |
| Auth services | [`src/modules/iam/auth/`](../../src/modules/iam/auth/) — `auth.service.js` (login / refresh / logout), `session.service.js` (rotation, deterministic token hashing), `mfa.service.js` (TOTP), `password.service.js` (forgot / reset) | [`iam/auth/README.md`](../../src/modules/iam/auth/README.md) |
| Models | [`User`](../../src/models/User.js), [`Admin`](../../src/models/Admin.js), [`Tenant`](../../src/models/Tenant.js), [`Session`](../../src/models/Session.js), [`LoginAttempt`](../../src/models/LoginAttempt.js) | [`iam/auth/STATUS.md`](../../src/modules/iam/auth/STATUS.md) |
| Routes (real) | [`/auth/*`](../../src/routes/auth.routes.js) + [`/admin-auth/*`](../../src/routes/admin-auth.routes.js) — login, refresh, logout, password, MFA, me | [`backend/authentication.md`](./backend/authentication.md) |
| Integration tests | [`tests/*.integration.test.js`](../../tests/README.md) — both portals, refresh replay family revocation, MFA with real TOTP, lockout, reset session revocation | [`tests/README.md`](../../tests/README.md) |

### Connector Platform (Sprint 4)

| Component | Implementation | Docs |
| --- | --- | --- |
| Models | [`Connector`](../../src/models/Connector.js) (config encrypted at rest, `webhookToken` sparse-unique, type + status) + [`ConnectorRow`](../../src/models/ConnectorRow.js) (`{connectorId, sourceRowId}` idempotency) | [`modules/connectors/STATUS.md`](../../src/modules/connectors/STATUS.md) |
| Providers + sync engine | `src/connectors/` framework (Phase 1.1) + [`csv`](../../src/modules/connectors/csv/) + [`webhook`](../../src/modules/connectors/webhook/) + [`shared`](../../src/modules/connectors/shared/) (field mapping, sync engine, validators) | [`backend/connectors.md`](./backend/connectors.md) |
| Queue consumer | [`connector.queue.js`](../../src/queues/connector.queue.js) — resolves connector, runs sync, upserts rows idempotently | [`backend/queues.md`](./backend/queues.md) |
| Routes (real) | [`/connectors/*`](../../src/routes/connector.routes.js) (CRUD, validate, rows, CSV preview/sync) + [`/webhooks/*`](../../src/routes/webhook.routes.js) — behind `authenticate → resolveTenant → permission('connectors', …)` | [`connector.routes.js`](../../src/routes/connector.routes.js) |

### Analytics Engine + Master Data (Sprint 5)

| Component | Implementation | Docs |
| --- | --- | --- |
| Engine | [`analytics.engine.js`](../../src/services/analytics.engine.js) — `queryRows`/`queryFacet`: filters, date presets, sort, pagination, projection; `groupBy` + metrics (sum/avg/count/min/max) aggregation; non-grouped queries return raw connector rows | [`analytics/README.md`](../../src/modules/analytics/README.md) |
| Service + cache | [`analytics.service.js`](../../src/services/analytics.service.js) + [`analytics.cache.js`](../../src/services/analytics.cache.js) (query cache keyed by `tenantId` + query hash) + query history via [`AnalyticsQuery`](../../src/models/AnalyticsQuery.js) | [`backend/cache.md`](./backend/cache.md) |
| Master Data | [`masterData.service.js`](../../src/services/masterData.service.js) + [`MasterData`](../../src/models/MasterData.js) — admin write, public cached read (`master-data:<category>`) | [`platform/master-data/STATUS.md`](../../src/modules/platform/master-data/STATUS.md) |
| Routes (real) | [`/analytics/*`](../../src/routes/analytics.routes.js) + [`/master-data/*`](../../src/routes/master-data.routes.js) | [`analytics.routes.js`](../../src/routes/analytics.routes.js) |

### Dashboards & Widgets (Sprint 6)

| Component | Implementation | Docs |
| --- | --- | --- |
| Models | [`Dashboard`](../../src/models/Dashboard.js) (layout, sharedWith, status draft/published/archived, versioned) + [`Widget`](../../src/models/Widget.js) (`WIDGET_TYPES` = kpi, table, bar, line, area, pie) | [`analytics/dashboards/README.md`](../../src/modules/analytics/dashboards/README.md) |
| Services | [`dashboard.service.js`](../../src/services/dashboard.service.js) (CRUD, publish, duplicate, share, soft-delete, `executeWidget`/`viewDashboard`) + [`widget.service.js`](../../src/services/widget.service.js) (six widget types) | [`dashboard.service.js`](../../src/services/dashboard.service.js) |
| Execution | Widget/dashboard execution delegates to the analytics engine; date presets (`last_7_days`, `last_30_days`, …); per-query cache with `updatedAt` revision so edits bust the cache; fail-closed (404 unknown dashboard/widget, 400 foreign/deleted dataset) | [`dashboard.routes.js`](../../src/routes/dashboard.routes.js) |
| Routes (real) | [`/dashboards/*`](../../src/routes/dashboard.routes.js) — full surface incl. `/:id/execute` + `/:id/widgets/:widgetId/execute`; `permission('dashboards', …)` + `analytics.view` required to run a widget | [`dashboard.routes.js`](../../src/routes/dashboard.routes.js) |

### Reports, Alerts & Notifications (Sprint 7)

| Component | Implementation | Docs |
| --- | --- | --- |
| Report models | [`Report`](../../src/models/Report.js) (status draft/published, source `widget`/`query`, schedule cron, `nextRunAt`, `runs[]` history) | [`analytics/reports/STATUS.md`](../../src/modules/analytics/reports/STATUS.md) |
| Report service + run | [`report.service.js`](../../src/services/report.service.js) — `create`/`update`/`list`/`get`/`remove`/`run`/`exportReport`/`processRun`/`runDue`. `run` enqueues an `ANALYTICS_JOBS` message; the worker executes off the HTTP path via the real analytics engine and stores the artefact. JSON/CSV/XLSX serialisation of flattened connector rows. `sanitizeReportQuery` preserves `datasetId`. | [`report.service.js`](../../src/services/report.service.js) |
| Report routes | [`/reports/*`](../../src/routes/report.routes.js) — full surface incl. `/:id/run`, `/:id/export?format=`; `permission('reports', …)`. Raw Mongo operators / `$where` / `$expr` rejected by the validator. | [`report.routes.js`](../../src/routes/report.routes.js) |
| Alert models | [`AlertRule`](../../src/models/AlertRule.js) (threshold + `datasetId`, schedule, `lastTriggeredAt`/`nextEvaluationAt`, `enabled`, `recipients`) + [`AlertEvent`](../../src/models/AlertEvent.js) (event history; `paginate` plugin) | [`alerts/STATUS.md`](../../src/modules/alerts/STATUS.md) |
| Alert service + evaluation | [`alert.service.js`](../../src/services/alert.service.js) — `create`/`update`/`list`/`get`/`remove`/`evaluate`/`evaluateDue`/`runDue`. `evaluate` runs the **real analytics engine** (`engine.queryRows`) against the alert's dataset/query, applies the threshold condition, records an `AlertEvent` and dispatches a notification on trigger. Disabled alerts never trigger; cooldown deduplicates. `sanitizeAlertQuery` preserves `datasetId`. | [`alert.service.js`](../../src/services/alert.service.js) |
| Alert routes | [`/alerts/*`](../../src/routes/alert.routes.js) — full surface incl. `/:id/evaluate`, `/:id/events`; `permission('alerts', …)`. | [`alert.routes.js`](../../src/routes/alert.routes.js) |
| Notification model + service | [`Notification`](../../src/models/Notification.js) + [`notification.service.js`](../../src/services/notification.service.js) + [`notification.repository.js`](../../src/repositories/notification.repository.js) — tenant/actor-scoped inbox, unread-count, mark-read, soft-delete, preferences. | [`platform/notifications/STATUS.md`](../../src/modules/platform/notifications/STATUS.md) |
| Notification routes | [`/notifications/*`](../../src/routes/notification.routes.js) — inbox, unread-count, mark-read (single + all), delete, preferences; `permission('notifications', …)`. | [`notification.routes.js`](../../src/routes/notification.routes.js) |
| Scheduling | `report.service.runDue` / `alert.service.runDue` + `evaluateDue` enqueue due work; `analytics.worker.js` processes report + alert job types. `tenantInitialization.service.js` seeds `reports.*` / `alerts.*` / `notifications.*` RBAC. | [`tenantInitialization.service.js`](../../src/services/tenantInitialization.service.js) |

### CI Guardrails

Wired to `npm run ci:guards`. All green as of Sprint 7 close (5/5).

| Guard | What it fails on | Script |
| --- | --- | --- |
| `check-stubs` | `notImplementedStub` outside the allowlist | [`check-stubs.js`](../../scripts/ci/check-stubs.js) |
| `check-routes` | a real route handler without an auth middleware (understands wrapper helpers that embed an auth guard, e.g. `guarded()` in the dashboards routes) | [`check-routes.js`](../../scripts/ci/check-routes.js) |
| `check-models` | `mongoose.model()` without a plugin import | [`check-models.js`](../../scripts/ci/check-models.js) |
| `check-config` | `process.env` outside `src/config/`, `tests/`, `scripts/ci/` | [`check-config.js`](../../scripts/ci/check-config.js) |
| `check-readme-sync` | missing root docs or per-module `STATUS.md` | [`check-readme-sync.js`](../../scripts/ci/check-readme-sync.js) |

See [`DECISIONS.md` ADR-010](./DECISIONS.md#adr-010-ci-guardrails).

### Test Coverage

```
auth-flow.integration.test.js             12 tests  (both portals, refresh replay family revocation)
admin-auth-mfa.integration.test.js         6 tests  (MFA two-step + real TOTP, login with code)
password-reset-session.integration.test.js 3 tests  (no enumeration, reset revokes sessions)
session-lifecycle.integration.test.js      7 tests  (deterministic lookup, rotate, revoke-all)
routes/rbac.integration.test.js           19 tests  (roles/permissions/admins/audit-logs/users gates)
rbac/services.integration.test.js         15 tests  (permission resolution + RBAC cache)
middleware/auth.test.js                   11 tests  (authenticate / adminAuth / optional*)
middleware/rbac.middleware.test.js        36 tests  (permission / denyIf enforcement)
validators/auth.test.js                    9 tests  (Sprint 1 auth/admin validator schemas)
validators/rbac.test.js                   15 tests  (roles/permissions/admins schemas)
models/plugins.test.js                     8 tests
tenants/tenant.integration.test.js          13 tests (Sprint 3 lifecycle + onboarding + settings + flags)
services/setting.service.test.js          10 tests (coercion, redaction, inheritance, cache, read-only)
services/email.test.js                     3 tests
utils/password.test.js                    10 tests  (KDF seam: scrypt + argon2)
utils/jwt.test.js                         10 tests
utils/idempotency.test.js                  7 tests
utils/id.test.js                           9 tests
utils/encryption.test.js                   8 tests
cache/memory.test.js                       8 tests
queues/memory.test.js                      5 tests
storage/local.test.js                      6 tests
health.test.js                             2 tests
connectors/connector.service.integration.test.js   6 tests  (Sprint 4 CRUD + validation + CSV sync)
modules/connectors/connectors.test.js      8 tests  (registry + provider wiring)
modules/connectors/csv/csv.parser.test.js  6 tests  (stream-parse, types, errors)
modules/connectors/shared/field-mapping.test.js   9 tests
modules/connectors/shared/sync-engine.test.js     6 tests  (idempotent row upsert)
modules/connectors/shared/validators.test.js     10 tests  (config schemas per type)
modules/connectors/webhook/webhook.verify.test.js 8 tests  (HMAC-SHA256 + replay window)
analytics/analytics.engine.raw.test.js     2 tests  (Sprint 5 raw row reads)
analytics/analytics.engine.filters.test.js 10 tests (filters, date presets, sort, paging)
analytics/analytics.engine.aggregations.test.js   6 tests (groupBy + metrics)
analytics/analytics.cache.test.js          3 tests  (query cache hit/miss)
analytics/analytics.service.test.js        6 tests  (service facade + history)
analytics/analytics.controller.test.js     5 tests  (route handlers)
master-data/masterData.test.js             8 tests  (Sprint 5 catalogue CRUD + cache + admin gate)
dashboards/dashboard.service.test.js       9 tests  (Sprint 6 dashboard CRUD/lifecycle/share)
dashboards/widget.service.test.js          8 tests  (Sprint 6 widget CRUD + six types)
dashboards/dashboard.execution.test.js     7 tests  (executeWidget/viewDashboard, cache, isolation, fail-closed)
dashboards/dashboard.routes.integration.test.js   4 tests  (HTTP end-to-end + RBAC 401/403)
reports/report.routes.integration.test.js          3 tests  (CRUD, RBAC 401/403, tenant isolation, run, JSON/CSV export, security)
alerts/alert.routes.integration.test.js            5 tests  (CRUD, RBAC 401/403, evaluation → event + notification, datasetId contract, disabled guard)
alerts/alert.scheduler.test.js                     4 tests  (evaluateDue + runDue, disabled skip, cooldown dedupe + re-trigger)
notifications/notification.routes.integration.test.js  2 tests  (inbox lifecycle, RBAC 401/403)
─────────────────────────────────────────────────────
TOTAL                                    367 tests
```

`npm test` runs the suite in scrypt KDF mode (portable); `npm run
test:argon2` exercises the real Argon2id KDF.

---

## What Is Still a Stub (Fail-Closed)

Every unimplemented business endpoint returns `501 Not Implemented` with a
provides a `hint` pointing to the module README that owns it. The CI guard
`check-routes` ensures this rule is never accidentally broken by a new
real handler.

> **Sprint 7 note:** `/reports/*` and `/notifications/*` are **no longer
> stubs** — they shipped in Sprint 7 (see the Reports/Alerts/Notifications
> section below). `/alerts/*` also shipped in Sprint 7 and is not listed
> here.

| Surface | Where it lives | Owning Sprint |
| --- | --- | --- |
| `/settings/*` | [`src/routes/settings.routes.js`](../../src/routes/settings.routes.js) | [Sprint 5](./phases/sprint-5.md) |
| `/feature-flags/*` | [`src/routes/feature-flag.routes.js`](../../src/routes/feature-flag.routes.js) | [Sprint 5](./phases/sprint-5.md) |
| `/email-templates/*` | [`src/routes/email-template.routes.js`](../../src/routes/email-template.routes.js) | [Sprint 5](./phases/sprint-5.md) |
| `/access-logs/*` | [`src/routes/access-log.routes.js`](../../src/routes/access-log.routes.js) | [Sprint 7](./phases/sprint-7.md) |
| `/compliance/*` | [`src/routes/compliance.routes.js`](../../src/routes/compliance.routes.js) | [Sprint 7](./phases/sprint-7.md) |
| `/monitoring/*` | [`src/routes/monitoring.routes.js`](../../src/routes/monitoring.routes.js) | [Sprint 8](./phases/sprint-8.md) |
| `/support/*` | [`src/routes/support.routes.js`](../../src/routes/support.routes.js) | [Sprint 8](./phases/sprint-8.md) |
| `/embed/*` | [`src/routes/embed.routes.js`](../../src/routes/embed.routes.js) | [Sprint 9](./phases/sprint-9.md) |

---

## What Is Planned vs Future

See [Product Roadmap](./03-product-roadmap.md) for the full plan. The
short version:

| Horizon | Scope |
| --- | --- |
| **Phase 2 (in flight)** | Sprints 0–9 deliver the MVP: auth, IAM, RBAC, connectors, analytics engine, master data, dashboards, reports/alerts/notifications, governance, monitoring, CSV reports + embed. Sprints 0–7 complete; Sprints 8–9 remain. |
| **Phase 3 (planned)** | KMS-managed keys, WebAuthn / passkey, multi-region, SIEM forwarder, cold archival to S3, hash-chain audit, OAuth/SAML SSO, SCIM 2.0, MongoDB + Google Sheets connectors, push + outbound webhook notifications, PDF/XLSX reports, anomaly detection cron, Prometheus `/metrics`. |
| **Phase 4+ (future)** | Data residency per tenant, connector marketplace, custom-domain tenant routing. |

Hooks for every Phase 3+ feature already exist (events on the `audit`
plugin, KMS swap point in `utils/encryption.js`, public-compliance
endpoint shape, etc.) so the architecture does not change when these
features land. See [DECISIONS.md](./DECISIONS.md) "Postponed Decisions".

---

## Next Milestone

**Sprint 8 — Monitoring + Support (🕓 planned).**

Concretely: get the remaining Phase 2 surfaces to production grade — the
`/monitoring/*` and `/support/*` route files exist as fail-closed stubs
and need real, RBAC-scoped handlers; plus the deferred governance surfaces
(`/access-logs/*`, `/compliance/*`) from the original Sprint 7 plan.

The same auth + RBAC middleware from Sprints 1–7 guards every surface;
`resolveTenant` scopes per tenant; `X-Idempotency-Key` protects every
mutation.

> **Note — Sprint 7 re-scoped:** Sprint 7 actually delivered **Reports,
> Alerts, Notifications & Scheduling** (not the governance surfaces the
> plan file describes). Those governance endpoints (`/access-logs/*`,
> `/compliance/*`) remain planned for Sprint 8. The Sprint 7 close-out is
> recorded in [`phases/sprint-7.md`](./phases/sprint-7.md).

### Sprint 7 retro notes (closed)

- **Delivered:** reports (CRUD + scheduled run off the HTTP path + JSON/CSV/XLSX
  export + run history), threshold alerts evaluated through the **real
  analytics engine** (event history + cooldown/dedup + notification
  dispatch), and the tenant/actor-scoped notification inbox — behind
  existing `reports.*` / `alerts.*` / `notifications.*` RBAC. Scheduling via
  `runDue` / `evaluateDue` + the analytics worker. 14 new integration tests
  (367 total).
- **Real bugs found and fixed (not test hacks):** `sanitizeAlertQuery` and
  `sanitizeReportQuery` stripped `datasetId` so query-source reports/alerts
  failed execution; `AlertEvent` was missing the `paginate` plugin
  (`listEvents` threw); `analytics.worker.js` dropped `tenantId` when calling
  `processRun`/`evaluate`, so the engine returned 0 rows. All fixed.
- **Watch out:** `npm test` must run without forcing `NODE_ENV=test` — the
  health test asserts `env === 'development'`. The integration harness runs
  batches of 8 spec files against one shared `mongodb-memory-server` to stay
  under mutex limits; run plain `npm test` (defaults to development) with
  `PASSWORD_KDF=scrypt`.
- **Deferred to later sprints:** email *channel* delivery (SMTP/noop transport
  exists; the outbound email consumer is a later sprint), outbound webhook /
  push notifications, PDF reports, embed surface.

### Sprint 6 retro notes (closed)

- **Went well:** dashboard + widget execution is fully covered at three
  layers — service unit tests, engine integration tests, and HTTP
  end-to-end (28 tests). Cache hit/miss + edit-bust verified; tenant
  isolation + RBAC (401/403) verified end-to-end. The `ci:check-routes`
  guard needed a small fix to recognise wrapper helpers (`guarded()`)
  that embed an auth middleware — verified both positive and negative
  cases.
- **Watch out:** dashboard execution returns the engine result object
  (rows + total + pagination), not a bare rows array; the analytics
  engine only aggregates when `groupBy` is non-empty — non-grouped
  queries return raw connector rows. Tests now reflect both.
- **Deferred to later sprints:** reports (`/reports/*`) and notifications
  (`/notifications/*`) shipped in Sprint 7 — only embed (`/embed/*`) and
  email-templates remain fail-closed stubs; per-dashboard realtime refresh
  rooms are still planned.

### Sprint 3 retro notes (closed)

- **Went well:** the tenant lifecycle held up under integration testing
  (13 tests); onboarding idempotency, settings inheritance + secret
  redaction, and the login/refresh tenant-status gate all landed as
  designed. The negative-cache incident (`getOrSet` memoising `null`)
  was caught by the setting-service tests and fixed in
  `src/cache/memory.js`.
- **Watch out:** sprint-planning docs and code had drifted — Sprint 3's
  RBAC scope had already shipped inside Sprint 2, and the `sprint-2.md`
  / `phase-2.md` files were never refreshed at the Sprint 2 close. The
  sprint doc discipline (update the sprint file in the closing PR) must
  be honoured going forward.
- **Deferred to later sprints:** Google Sheets / MongoDB connectors and
  outbound webhook notifications remain Phase 3.

---

## How Status Is Maintained

- Every PR that closes a sprint updates this file in the same commit.
- Every stub that becomes a real handler is removed from the
  [Stubs table](#what-is-still-a-stub-fail-closed).
- Every new CI guard is added to the [CI Guardrails table](#ci-guardrails).
- Every test added is appended to the [Test Coverage table](#test-coverage).

If you spot a discrepancy between this file and the code, **the code is
right** — open a PR to fix the doc in the same change.

---

## Summary

`STATUS.md` is the daily-read source of truth: the *Current Development*
section at the top answers "what am I doing today?", the *At a Glance*
table is the dashboard, the *Milestone Tracker* is the journey, and
the *Shipped vs Stubbed vs Planned* tables are the inventory. It is the
single document updated as part of every sprint closure PR.

## Key Takeaways

- Open this file first thing every day. Read the *Current Development*
  block.
- The status labels (`Implemented`, `Partial`, `Stub`, `Planned`,
  `Future`) are the same everywhere; do not paraphrase them.
- The doc reflects the code, not the wishlist. If they disagree, the
  code is right.

## Interview Preparation

### Common Questions

- "How do you keep documentation in sync with code?"
- "What does 'fail-closed' mean and how do you enforce it?"
- "How would you ship a sprint without breaking the API for clients?"

### Sample Answers

- **"How do you keep documentation in sync with code?"** — Every sprint
  closure PR updates `STATUS.md` in the same commit. The CI guard
  `check-readme-sync` reminds the contributor to keep module `STATUS.md`
  files current. `npm run ci:guards` is part of the Definition of Done.

- **"What does 'fail-closed' mean and how do you enforce it?"** —
  Security middleware that is not yet implemented must reject traffic
  (`501 Not Implemented`) rather than silently allow it. Every
  unimplemented surface in this codebase throws an `ApiError` with
  `ERROR_CODES.NOT_IMPLEMENTED`. The `check-stubs` CI guard fails any
  new `notImplementedStub` that is not on the explicit allowlist.

- **"How would you ship a sprint without breaking the API for clients?"**
  — Two safeguards: (1) every new endpoint mounts `validateRequest()`
  so bad input fails 422, not 500; (2) the central `errorHandler`
  formats every failure into the documented envelope, so the client
  contract is the envelope shape — never raw stack traces.

### Real-World Examples

- A new engineer opens `STATUS.md` on Monday, sees *Next Deliverable:
  Sprint 8 — Monitoring + Support*, opens [`Sprint 8`](./phases/sprint-8.md)
  for the deliverables list, and starts on the smallest unblocked
  item. No Slack thread required.
- A reviewer opens a PR and runs `npm run ci:guards`. `check-routes`
  fails because the new `/admin/audit` route lacks an auth middleware.
  The contributor adds `adminAuth` and re-runs.

### Common Mistakes

- Treating this file as a marketing surface. It is an engineering
  instrument; it must be precise, not aspirational.
- Editing the *What Is Shipped Today* table without updating the code.
- Adding a new route without mounting auth and relying on reviewers to
  notice. The CI guard exists exactly so reviewers do not have to.

## Related Documents

- [`README.md`](./README.md) — documentation homepage
- [`01-getting-started.md`](./01-getting-started.md) — onboarding
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system diagram + request lifecycle
- [`DECISIONS.md`](./DECISIONS.md) — architectural decisions
- [`phases/README.md`](./phases/README.md) — sprint index
- [Repo-root `CHANGELOG.md`](../../CHANGELOG.md) — chronological log

## Last Updated

- **Sprint:** Sprint 6 close (Dashboards & Widgets)
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-12
- **Author:** Engineering (Sprint 6 close, re-scope note for Sprints 5–6)
- **Date:** 2026-08-08
- **Author:** Engineering (Sprint 3 close, Sprint 4 re-scope)
- **Date:** 2026-08-06
- **Author:** Engineering (Sprint 1)