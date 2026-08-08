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
> Sprint 2 ✅, Sprint 3 ✅ (Multi-Tenancy). Sprints 4–9 🕓 planned.
> **Sprint:** Sprint 3 — Multi-Tenancy (complete).
> **Owner:** Engineering team.
>
> Last updated: **Sprint 3 close** — see [CHANGELOG.md](../../CHANGELOG.md)
> at the repo root for the entry-by-entry record.

---

## 🚦 Current Development — Read This First

> **This is the section every engineer reads before starting work each
> day.** It answers the questions that decide what you should be doing
> right now.

| Question | Answer |
| --- | --- |
| **Current Phase** | Phase 2 — Implementation |
| **Current Sprint** | Sprint 3 — Multi-Tenancy (✅ implemented). Sprints 0–3 complete; Sprints 4–9 planned. |
| **Current Goal** | Sprint 3 closes the tenant lifecycle: provisioning, onboarding, suspend/restore/disable/archive with session + cache cascade, the login/refresh tenant-status gate, tenant settings (inheritance + redaction + read-only), feature flags, and the admin-gated `/tenants/*` surface. |
| **Current Progress (%)** | **~65 %** of Phase 2 complete. Sprints 0–1 (foundation + auth) and Sprints 2–3 (IAM + multi-tenancy) are the four finished sprints of ten. |
| **Last Completed Milestone** | Sprint 3 close — multi-tenancy: tenant lifecycle, onboarding, auth gate, tenant settings, feature flags, statistics, members, billing, `/tenants/*` API. See [Sprint 3](./phases/sprint-3.md). |
| **Next Deliverable** | Sprint 4 — Connector Platform (CSV + Webhook connectors, sync engine, inbound webhook surface). |
| **Current Blockers** | **None known.** 232 tests pass, CI green, `npm audit` clean. |
| **Definition of Done (current sprint)** | *(Sprint 3)* ✅ All deliverables merged, 232 tests green, CI green, status docs updated. *(Sprint 4)* 🕓 See [Sprint 4](./phases/sprint-4.md). |
| **Last Updated** | Sprint 3 close. This file is updated as part of every sprint closure PR. |

### What You Should Be Doing Right Now

| If you are… | Do this |
| --- | --- |
| **About to start Sprint 4** | Read [Sprint 4 plan](./phases/sprint-4.md) end-to-end, then [Connector deep-dive](./backend/connectors.md) and the connectors module READMEs. Open the sprint branch. |
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
| **Current sprint** | Sprint 3 — Multi-Tenancy (✅ complete) |
| **Next sprint** | Sprint 4 — Connector Platform |
| **Repository version** | `1.0.0` |
| **Tests** | 232 pass, 0 fail |
| **CI guards** | 5 / 5 green |
| **`npm audit`** | 0 vulnerabilities |
| **Production features shipped** | 3 of ~30 (auth, IAM, multi-tenancy) |

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

…          ── Sprints 4 → 9: see [Sprint Log](#sprint-log).

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
| 2 | Implementation (Sprints 0–9) | 🟡 Partial | Sprints 0–3 complete (auth, IAM, multi-tenancy); Sprints 4–9 planned |
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
| [Sprint 4](./phases/sprint-4.md) | Connector Platform (CSV + Webhook connectors, sync engine, inbound webhook surface) | 🕓 Planned | — |
| [Sprint 5](./phases/sprint-5.md) | Platform: settings, feature flags, notifications | 🕓 Planned | — |
| [Sprint 6](./phases/sprint-6.md) | Master Data (countries, currencies, timezones, plans, languages) | 🕓 Planned | — |
| [Sprint 7](./phases/sprint-7.md) | Governance: audit, access, compliance | 🕓 Planned | — |
| [Sprint 8](./phases/sprint-8.md) | Monitoring + Support | 🕓 Planned | — |
| [Sprint 9](./phases/sprint-9.md) | Analytics + Embed | 🕓 Planned | — |

---

## What Is Shipped Today (Sprint 1)

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
| [`tenantIsolation`](../../src/middleware/tenantIsolation.middleware.js) | ⛔ Fail-closed stub | Sprint 2 |
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

### CI Guardrails

Wired to `npm run ci:guards`. All green as of Sprint 3 close.

| Guard | What it fails on | Script |
| --- | --- | --- |
| `check-stubs` | `notImplementedStub` outside the allowlist | [`check-stubs.js`](../../scripts/ci/check-stubs.js) |
| `check-routes` | a real route handler without an auth middleware | [`check-routes.js`](../../scripts/ci/check-routes.js) |
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
routes/rbac.integration.test.js            8 tests  (roles/permissions/admins/audit-logs/users gates)
rbac/services.integration.test.js          7 tests  (permission resolution + RBAC cache)
middleware/auth.test.js                   11 tests  (authenticate / adminAuth / optional*)
middleware/rbac.middleware.test.js        4 tests  (permission / denyIf enforcement)
validators/auth.test.js                    9 tests  (Sprint 1 auth/admin validator schemas)
validators/rbac.test.js                    8 tests  (roles/permissions/admins schemas)
models/plugins.test.js                     8 tests
tenants/tenant.integration.test.js          13 tests (Sprint 3 lifecycle + onboarding + settings + flags)
services/setting.service.test.js          10 tests (coercion, redaction, inheritance, cache, read-only)
utils/password.test.js                    10 tests  (KDF seam: scrypt + argon2)
utils/jwt.test.js                         10 tests
utils/idempotency.test.js                  7 tests
utils/id.test.js                           9 tests
utils/encryption.test.js                   8 tests
cache/memory.test.js                       8 tests
queues/memory.test.js                      5 tests
storage/local.test.js                      6 tests
services/email.test.js                     3 tests
health.test.js                             2 tests
─────────────────────────────────────────────────────
TOTAL                                    232 tests
```

`npm test` runs the suite in scrypt KDF mode (portable); `npm run
test:argon2` exercises the real Argon2id KDF.

---

## What Is Still a Stub (Fail-Closed)

Every unimplemented business endpoint returns `501 Not Implemented` with a
`hint` pointing to the module README that owns it. The CI guard
`check-routes` ensures this rule is never accidentally broken by a new
real handler.

| Surface | Where it lives | Owning Sprint |
| --- | --- | --- |
| `/master-data/*` | [`src/routes/master-data.routes.js`](../../src/routes/master-data.routes.js) | [Sprint 4](./phases/sprint-4.md) |
| `/settings/*` | [`src/routes/settings.routes.js`](../../src/routes/settings.routes.js) | [Sprint 5](./phases/sprint-5.md) |
| `/feature-flags/*` | [`src/routes/feature-flag.routes.js`](../../src/routes/feature-flag.routes.js) | [Sprint 5](./phases/sprint-5.md) |
| `/notifications/*` | [`src/routes/notification.routes.js`](../../src/routes/notification.routes.js) | [Sprint 5](./phases/sprint-5.md) |
| `/email-templates/*` | [`src/routes/email-template.routes.js`](../../src/routes/email-template.routes.js) | [Sprint 5](./phases/sprint-5.md) |
| `/connectors/*` | [`src/routes/connector.routes.js`](../../src/routes/connector.routes.js) | [Sprint 4](./phases/sprint-4.md) |
| `/webhooks/*` | [`src/routes/webhook.routes.js`](../../src/routes/webhook.routes.js) | [Sprint 4](./phases/sprint-4.md) |
| `/access-logs/*` | [`src/routes/access-log.routes.js`](../../src/routes/access-log.routes.js) | [Sprint 7](./phases/sprint-7.md) |
| `/compliance/*` | [`src/routes/compliance.routes.js`](../../src/routes/compliance.routes.js) | [Sprint 7](./phases/sprint-7.md) |
| `/monitoring/*` | [`src/routes/monitoring.routes.js`](../../src/routes/monitoring.routes.js) | [Sprint 8](./phases/sprint-8.md) |
| `/support/*` | [`src/routes/support.routes.js`](../../src/routes/support.routes.js) | [Sprint 8](./phases/sprint-8.md) |
| `/dashboards/*` | [`src/routes/dashboard.routes.js`](../../src/routes/dashboard.routes.js) | [Sprint 9](./phases/sprint-9.md) |
| `/reports/*` | [`src/routes/report.routes.js`](../../src/routes/report.routes.js) | [Sprint 9](./phases/sprint-9.md) |
| `/embed/*` | [`src/routes/embed.routes.js`](../../src/routes/embed.routes.js) | [Sprint 9](./phases/sprint-9.md) |

---

## What Is Planned vs Future

See [Product Roadmap](./03-product-roadmap.md) for the full plan. The
short version:

| Horizon | Scope |
| --- | --- |
| **Phase 2 (in flight)** | Sprints 0–9 deliver the MVP: auth, IAM, RBAC, master data, platform config, CSV + webhook ingestion, governance, monitoring, dashboards + CSV reports + embed. |
| **Phase 3 (planned)** | KMS-managed keys, WebAuthn / passkey, multi-region, SIEM forwarder, cold archival to S3, hash-chain audit, OAuth/SAML SSO, SCIM 2.0, MongoDB + Google Sheets connectors, push + outbound webhook notifications, PDF/XLSX reports, anomaly detection cron, Prometheus `/metrics`. |
| **Phase 4+ (future)** | Data residency per tenant, connector marketplace, custom-domain tenant routing. |

Hooks for every Phase 3+ feature already exist (events on the `audit`
plugin, KMS swap point in `utils/encryption.js`, public-compliance
endpoint shape, etc.) so the architecture does not change when these
features land. See [DECISIONS.md](./DECISIONS.md) "Postponed Decisions".

---

## Next Milestone

**Sprint 4 — Connector Platform (CSV + Webhook).**

Concretely: by the end of Sprint 4 a developer can, against a real
`mongodb-memory-server` database:

1. `POST /connectors` — create a tenant-scoped CSV connector (config
   encrypted at rest).
2. `POST /connectors/:id/upload` — upload a CSV, which enqueues a sync.
3. Consumer ingests the file → rows land in MongoDB (idempotent on
   replay).
4. `POST /webhooks/:webhookToken` — inbound webhook with a valid
   HMAC-SHA256 signature → 200, ingested; invalid signature → 401.

The same auth + RBAC middleware from Sprints 1–3 guards every admin
surface; `resolveTenant` scopes connectors per tenant; `X-Idempotency-Key`
protects every mutation.

The Definition of Done for Sprint 4 lives in
[`phases/sprint-4.md`](./phases/sprint-4.md).

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
- **Deferred to later sprints:** Master Data (originally Sprint 4)
  moved to [Sprint 6](./phases/sprint-6.md) when the Connector Platform
  was prioritised into Sprint 4; Google Sheets / MongoDB connectors and
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
  Sprint 2 — IAM*, opens [`Sprint 2`](./phases/sprint-2.md)
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

- **Sprint:** Sprint 3 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-08
- **Author:** Engineering (Sprint 3 close, Sprint 4 re-scope)
- **Date:** 2026-08-06
- **Author:** Engineering (Sprint 1)