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
> closure PR. The state it describes: Sprint 0 ✅, Sprint 1 🕓 planned.
> **Sprint:** Between Sprint 0 (complete) and Sprint 1 (planned).
> **Owner:** Engineering team.
>
> Last updated: **Sprint 0 close** — see [CHANGELOG.md](../../CHANGELOG.md)
> at the repo root for the entry-by-entry record.

---

## 🚦 Current Development — Read This First

> **This is the section every engineer reads before starting work each
> day.** It answers the questions that decide what you should be doing
> right now.

| Question | Answer |
| --- | --- |
| **Current Phase** | Phase 2 — Implementation |
| **Current Sprint** | Between Sprint 0 (✅ complete) and Sprint 1 (🕓 planned). Sprint 1 has not been opened yet. |
| **Current Goal** | Hand off a clean Sprint 0 foundation and begin Sprint 1 — Authentication. The next commit should land the first real `authenticate` middleware, the `User` / `Admin` / `Session` models, and a working `POST /admin-auth/login` round-trip. |
| **Current Progress (%)** | **~15 %** of Phase 2 complete. Sprint 0 is the only finished sprint of ten. Foundation utilities, infrastructure drivers, plugin set, idempotency, CI guardrails, and 73 tests are done. |
| **Last Completed Milestone** | Sprint 0 close — shared implementation foundation. See [Sprint 0](./phases/sprint-0.md) for deliverables. |
| **Next Deliverable** | Sprint 1 — Authentication. Concretely: a developer running `npm run dev` can `POST /admin-auth/login` with email + password, get back an access token + refresh cookie, call `GET /admin-auth/me`, and `POST /admin-auth/logout`. The same flow ships for `/auth/*` (tenant users). |
| **Current Blockers** | **None known.** Sprint 0 deliverables are merged; CI is green; no open dependency on other teams. The blockers table is empty for the first time in the project. |
| **Definition of Done (current sprint)** | *(Sprint 0)* ✅ All Sprint 0 deliverables merged, tests green, CI green, `npm audit` clean, status docs updated. *(Sprint 1)* 🕓 See [Sprint 1](./phases/sprint-1.md) — to be opened when work begins. |
| **Last Updated** | Sprint 0 close. This file is updated as part of every sprint closure PR. |

### What You Should Be Doing Right Now

| If you are… | Do this |
| --- | --- |
| **About to start Sprint 1** | Read [Sprint 1 plan](./phases/sprint-1.md) end-to-end, then [Authentication reference](./backend/authentication.md) and [Multi-Tenancy reference](./backend/multi-tenancy.md). Open the sprint branch. |
| **Reviewing a PR** | Run `npm run ci:guards` and `npm test` locally. Check that any new route has an auth middleware (CI guard will flag it). Check that the matching entry in `STATUS.md` was updated. |
| **Debugging a flaky test** | Run the affected file with `node --test tests/<path>.test.js`. Tests use `mongodb-memory-server`; the first run downloads a MongoDB binary (~80 MB). |
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
| **Current sprint** | Sprint 0 (shared implementation foundation) — **complete** |
| **Next sprint** | Sprint 1 — Authentication |
| **Repository version** | `1.0.0` |
| **Tests** | 73 pass, 0 fail |
| **CI guards** | 5 / 5 green |
| **`npm audit`** | 0 vulnerabilities |
| **Production features shipped** | 0 of ~30 (foundation only) |

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

Sprint 1   🕓 ── Authentication: User, Admin, Session models;
                  real authenticate / adminAuth / authorize;
                  /auth/* and /admin-auth/* routes; account
                  lockout; refresh-token rotation; TOTP MFA for
                  super_admin.

…          ── Sprints 2 → 9: see [Sprint Log](#sprint-log).

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
| 2 | Implementation (Sprints 0–9) | 🟡 Partial | Sprint 0 complete; Sprints 1–9 planned |
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
| [Sprint 1](./phases/sprint-1.md) | Authentication (User, Admin, MFA, refresh) | 🕓 Planned | — |
| [Sprint 2](./phases/sprint-2.md) | IAM (admins, tenants, users, lifecycle) | 🕓 Planned | — |
| [Sprint 3](./phases/sprint-3.md) | RBAC (modules, permissions, roles) | 🕓 Planned | — |
| [Sprint 4](./phases/sprint-4.md) | Master Data (countries, currencies, timezones, plans, languages) | 🕓 Planned | — |
| [Sprint 5](./phases/sprint-5.md) | Platform: settings, feature flags, notifications | 🕓 Planned | — |
| [Sprint 6](./phases/sprint-6.md) | Connectors: CSV + Webhook | 🕓 Planned | — |
| [Sprint 7](./phases/sprint-7.md) | Governance: audit, access, compliance | 🕓 Planned | — |
| [Sprint 8](./phases/sprint-8.md) | Monitoring + Support | 🕓 Planned | — |
| [Sprint 9](./phases/sprint-9.md) | Analytics + Embed | 🕓 Planned | — |

---

## What Is Shipped Today (Sprint 0)

The following exist as production-grade code, not as stubs. Every bullet
links to the canonical documentation.

### Utilities

| Component | Implementation | Docs |
| --- | --- | --- |
| JWT signing & verification | [`src/utils/jwt.js`](../../src/utils/jwt.js) — `jose`, audience + issuer aware, typed `JwtError` | [`DECISIONS.md` ADR-001](./DECISIONS.md#adr-001-adopt-jose-over-jsonwebtoken-for-jwt) |
| Password hashing | [`src/utils/password.js`](../../src/utils/password.js) — Argon2id (`argon2id`, OWASP defaults) | [`DECISIONS.md` ADR-002](./DECISIONS.md#adr-002-argon2id-for-password-hashing) |
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
| [`authenticate`, `authorize`, `optionalAuthenticate`](../../src/middleware/auth.middleware.js) | ⛔ Fail-closed stubs | Return 501; Sprint 1 will wire JWT |
| [`adminAuth`, `adminAuthOptional`](../../src/middleware/adminAuth.middleware.js) | ⛔ Fail-closed stub | Sprint 1 |
| [`resolveTenant`](../../src/middleware/tenant.middleware.js) | ⛔ Fail-closed stub | Sprint 1 |
| [`tenantIsolation`](../../src/middleware/tenantIsolation.middleware.js) | ⛔ Fail-closed stub | Sprint 2 |
| [`rbac`, `permission`, `modulePermission`](../../src/middleware/) | ⛔ Fail-closed stubs | Sprint 3 |
| [`audit`, `accessLog`](../../src/middleware/) | ⛔ Fail-closed stubs | Sprint 7 |
| [`compliance.*`](../../src/middleware/compliance.middleware.js) | ⛔ Fail-closed stub | Sprint 7 |

### CI Guardrails

Wired to `npm run ci:guards`. All green as of Sprint 0 close.

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
utils/jwt.test.js                  11 tests
utils/password.test.js              7 tests
utils/id.test.js                    9 tests
utils/encryption.test.js            7 tests
utils/idempotency.test.js           7 tests
cache/memory.test.js                8 tests
queues/memory.test.js               5 tests
storage/local.test.js               6 tests
services/email.test.js              3 tests
models/plugins.test.js              8 tests
health.test.js (existing)           2 tests
─────────────────────────────────────────────
TOTAL                              73 tests
```

---

## What Is Still a Stub (Fail-Closed)

Every unimplemented business endpoint returns `501 Not Implemented` with a
`hint` pointing to the module README that owns it. The CI guard
`check-routes` ensures this rule is never accidentally broken by a new
real handler.

| Surface | Where it lives | Owning Sprint |
| --- | --- | --- |
| `/auth/*` (login, refresh, logout, password, MFA, me) | [`src/routes/auth.routes.js`](../../src/routes/auth.routes.js) | [Sprint 1](./phases/sprint-1.md) |
| `/admin-auth/*` | [`src/routes/admin-auth.routes.js`](../../src/routes/admin-auth.routes.js) | [Sprint 1](./phases/sprint-1.md) |
| `/tenants/*` | [`src/routes/tenant.routes.js`](../../src/routes/tenant.routes.js) | [Sprint 2](./phases/sprint-2.md) |
| `/admin/admins/*` | [`src/routes/admin.routes.js`](../../src/routes/admin.routes.js) | [Sprint 2](./phases/sprint-2.md) |
| `/tenants/:id/users/*` | [`src/routes/user.routes.js`](../../src/routes/user.routes.js) | [Sprint 2](./phases/sprint-2.md) |
| `/roles/*` | [`src/routes/role.routes.js`](../../src/routes/role.routes.js) | [Sprint 3](./phases/sprint-3.md) |
| `/permissions/*` | [`src/routes/permission.routes.js`](../../src/routes/permission.routes.js) | [Sprint 3](./phases/sprint-3.md) |
| `/master-data/*` | [`src/routes/master-data.routes.js`](../../src/routes/master-data.routes.js) | [Sprint 4](./phases/sprint-4.md) |
| `/settings/*` | [`src/routes/settings.routes.js`](../../src/routes/settings.routes.js) | [Sprint 5](./phases/sprint-5.md) |
| `/feature-flags/*` | [`src/routes/feature-flag.routes.js`](../../src/routes/feature-flag.routes.js) | [Sprint 5](./phases/sprint-5.md) |
| `/notifications/*` | [`src/routes/notification.routes.js`](../../src/routes/notification.routes.js) | [Sprint 5](./phases/sprint-5.md) |
| `/email-templates/*` | [`src/routes/email-template.routes.js`](../../src/routes/email-template.routes.js) | [Sprint 5](./phases/sprint-5.md) |
| `/connectors/*` | [`src/routes/connector.routes.js`](../../src/routes/connector.routes.js) | [Sprint 6](./phases/sprint-6.md) |
| `/webhooks/*` | [`src/routes/webhook.routes.js`](../../src/routes/webhook.routes.js) | [Sprint 6](./phases/sprint-6.md) |
| `/audit-logs/*` | [`src/routes/audit-log.routes.js`](../../src/routes/audit-log.routes.js) | [Sprint 7](./phases/sprint-7.md) |
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

**Sprint 1 — Authentication.**

Concretely: by the end of Sprint 1 a developer running `npm run dev` can:

1. `POST /admin-auth/login` with email + password and receive an access
   token (15 min) + refresh cookie.
2. `POST /admin-auth/refresh` to rotate the refresh token.
3. `GET /admin-auth/me` with the access token and see the admin's profile.
4. `POST /admin-auth/logout` to revoke the session.

The same shape is delivered for `/auth/*` (tenant users).

The Definition of Done for Sprint 1 lives in
[`phases/sprint-1.md`](./phases/sprint-1.md).

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
  Sprint 1 — Authentication*, opens [`Sprint 1`](./phases/sprint-1.md)
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

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)