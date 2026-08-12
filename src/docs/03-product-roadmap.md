# 03 — Product Roadmap

> **WHAT this is:** the phase-by-phase plan from foundation to
> enterprise-ready platform.
> **WHY it exists:** without a single source of truth for *what is
> shipped, what is scheduled and what is not*, every planning
> conversation restarts from zero.
> **HOW to use it:** read the *Phase Status* table for the bird's-eye
> view; then drill into the matching phase document for deliverables,
> dependencies and completion criteria.
> **WHEN to update it:** at the close of every sprint. Update the
> matching phase row and the matching sprint log entry in `STATUS.md`
> in the same commit.
> **WHERE it lives:** `src/docs/03-product-roadmap.md`.

---

## Purpose

> **WHAT this is:** the canonical phase-by-phase plan for the SaaS
> Analytics Platform.
> **WHY it exists:** engineers, product and ops need one document that
> answers *"what are we building, in what order, by when?"* — without
> it, every planning conversation restarts from zero.
> **HOW to use it:** open this file before any sprint-planning meeting
> and after every sprint closure.
> **WHEN to update it:** when a phase status changes, when a sprint is
> added or removed, when a dependency shifts.
> **WHERE it lives:** `src/docs/03-product-roadmap.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Backend engineer** | Knows which phase is current and which sprint is next; opens the matching `phases/sprint-N.md` for scope. |
| **Product manager** | Sees deliverable dates shift as sprints complete; can re-prioritise future phases. |
| **Tech lead** | Sees dependency chains between phases; can staff sprints accordingly. |
| **Sales / founder** | Has a stable external-facing timeline they can quote without grepping Slack. |
| **Interview candidate** | Has a single document that explains the *why* behind every architectural decision. |

## Current Status

> **Status:** `In Progress` — Phase 2 (Sprints 0–7 complete; Sprint 7 re-scoped to Reports, Alerts, Notifications & Scheduling; Sprints 8–9 planned).
> **Sprint:** Sprint 7 (✅ complete — Reports, Alerts, Notifications & Scheduling — re-scoped from Governance) → Sprint 8 — Monitoring + Support (+ Governance surfaces).
> **Owner:** Engineering team.

## Business Perspective

The roadmap exists to convert the [business vision](./02-project-vision.md) into a delivery sequence. Three principles drive the order:

1. **Foundation before features.** Phase 1 ships the architecture; Sprint 0 ships the implementation foundation. No user-visible feature ships until both are in place.
2. **Tenant isolation first, RBAC second, business features third.** Phase 2 / Sprints 1–3 establish who is allowed to do what before any business endpoint ships.
3. **Connectors first, dashboards after connectors.** Dashboards (Sprint 9) depend on the Connector Platform (Sprint 4) having ingested data, which depends on sprints 1–4 being solid (auth, IAM/RBAC, multi-tenancy + the connector framework from Phase 1.1).

The roadmap is *not* a contract with a customer; it is a planning
instrument for the team. When reality diverges, the roadmap updates —
slowly, with intent, never as a surprise.

## Technical Perspective

Every phase has a **completion criterion**: a measurable technical
condition that must hold before the phase is marked *Completed*.

| Phase | Completion criterion (technical) |
| --- | --- |
| **1** | `npm run dev` boots; `GET /api/v1/health` returns 200; one integration test passes. |
| **1.1** | `BaseConnector` exists, is unit-tested, and a concrete connector (any one) registers at boot without error. |
| **1.2** | Every planned route shell exists and returns `501` with a `hint`; every middleware stub fails closed. |
| **2** | A user can sign up, invite a teammate, ingest a CSV, build a dashboard, share an embed, and revoke their own session — end-to-end. |
| **3+** | Each phase ships the enterprise feature list below with the same Definition of Done as Phase 2. |

The detailed per-sprint criteria live in
[`phases/`](./phases/README.md).

## Architecture

```
                Phase 1           Phase 1.1         Phase 1.2          Phase 2
                ──────           ──────────         ──────────          ───────
   Foundation:  ✅ Done          ✅ Done           ✅ Done             🟡 In flight
                  │                │                 │                  │
                  ▼                ▼                 ▼                  ▼
                Process         Connectors        Fail-closed        Real auth,
                bootstrap       + infra           stubs everywhere    IAM, RBAC,
                + Express +     contracts         (501 + hint)        governance,
                Mongoose +                                          analytics, embed
                Socket.IO
                                                      │
                                                      ▼
                                              Sprint 0 (✅)
                                              Shared impl:
                                              jwt, password,
                                              encryption, plugins,
                                              cache, queue, storage,
                                              email, idempotency,
                                              CI guardrails

                                              Sprint 1–9 (🕓)
                                              Real business endpoints,
                                              real models, real
                                              consumers, real reports.

                       Phase 3+ (🔮 Future)
                       Enterprise: KMS, WebAuthn, SIEM,
                       multi-region, OAuth/SAML, SCIM,
                       hash-chain audit, Google Sheets /
                       MongoDB / push / outbound webhook
                       notifications, PDF / XLSX reports,
                       anomaly detection, Prometheus.
```

> The dependency graph is **strict**: nothing in Phase 2 may be skipped
> before Phase 3 starts; nothing in Phase 3 may be skipped before
> Phase 4 starts. The CI guard `check-stubs` enforces that the
> fail-closed discipline is never broken.

## Phase Status

| Phase | Name | Status | Completion | Owner docs |
| --- | --- | --- | --- | --- |
| **1** | Production Backend Foundation | `Completed` | ✅ | [`ARCHITECTURE.md`](./ARCHITECTURE.md), [repo-root `README.md`](../../README.md) |
| **1.1** | Connector & Infrastructure Architecture | `Completed` | ✅ | [`src/connectors/`](../../src/connectors/) |
| **1.2** | Platform Management Architecture | `Completed` | ✅ | [`src/modules/`](../../src/modules/) |
| **2** | Implementation (Sprints 0-9) | `In Progress` | Sprints 0-3 ✅; Sprint 4 🕑 In Progress (Connector Platform); Sprints 5-9 🕑 Planned | [`phases/sprint-0.md`](./phases/sprint-0.md) → [`phases/sprint-9.md`](./phases/sprint-9.md) |
| **3** | Enterprise Features | `Future` | — | [`DECISIONS.md` "Postponed Decisions"](./DECISIONS.md#postponed-decisions-phase-3) |
| **4** | Advanced Enterprise | `Future` | — | (planned) |
| **5** | Mobile Apps & SDKs | `Future` | — | (planned) |
| **6** | AI / ML Features | `Future` | — | (planned) |
| **7** | White-label / Multi-operator | `Future` | — | (planned) |

Detailed per-phase plans are below.

---

## Phase 1 — Production Backend Foundation

### Purpose

Establish the *architecture* of the backend so every later phase can
build on a stable contract.

### Goals

- Single boot path (`src/server.js`) that wires HTTP, Socket.IO,
  MongoDB and the scheduler.
- Single Express assembly (`src/app.js`) with the documented
  middleware order.
- Single error envelope (`ApiError` + `errorHandler`).
- Single configuration loader (`config/env.js`) that no other file
  may bypass.

### Deliverables

- `src/app.js`, `src/server.js`
- `src/config/` (env, constants, cors, database, logger, mail,
  scheduler, socket)
- `src/middleware/` (requestId, error, notFound, rateLimiter,
  validation, plus fail-closed stubs)
- `src/validators/` (engine + per-feature stubs)
- `src/websocket/` (bootstrap + events + rooms)
- `src/jobs/` (node-cron scheduler + 4 job stubs)
- `src/connectors/` (BaseConnector + registry + stubs)
- `src/cache/`, `src/storage/`, `src/queues/` (facades + fail-closed
  stubs)
- `src/utils/` (ApiError, ApiResponse, asyncHandler, crypto,
  helpers, date, logger, stubs)

### Dependencies

None — Phase 1 is the foundation.

### Completion Criteria

- `npm install` succeeds.
- `npm run dev` boots the server.
- `npm test` runs and passes (smoke suite).
- `GET /api/v1/health` returns 200 with the standard envelope.
- Every planned route returns `501` with a `hint` pointing at the
  module README.

### Current Status

`Completed`. Verified by `npm test` (2/2 pass) and `npm run dev`
(binds port 8080, prints the startup line).

### Expected Outcome

A repository that a new engineer can clone, install, run and explore
without any business feature being live — and without any architectural
discipline being violated.

---

## Phase 1.1 — Connector & Infrastructure Architecture

### Purpose

Define the *connector framework* so adding CSV / Google Sheets /
Webhook / MongoDB / PostgreSQL / REST / GraphQL / Snowflake / BigQuery
later is a single-file change, not a refactor.

### Goals

- One `BaseConnector` contract covering `connect`, `validate`,
  `preview`, `ingest`, `disconnect`.
- One registry that validates subclasses, throws on duplicate `type`.
- Stable error contract for every connector.

### Deliverables

- `src/connectors/BaseConnector.js`
- `src/connectors/ConnectorRegistry.js`
- `src/connectors/index.js` facade
- `src/connectors/README.md`

### Dependencies

Phase 1.

### Completion Criteria

- `BaseConnector` is unit-tested.
- A test connector registers at boot without error.
- No concrete provider is required to be implemented in this phase;
  Phase 2 / Sprint 6 will deliver the first ones.

### Current Status

`Completed`. `BaseConnector` and the registry are in place; no
concrete provider is registered yet.

### Expected Outcome

When Sprint 6 starts, the engineer writes
`src/modules/connectors/csv/csv.connector.js` extending
`BaseConnector`, calls `registerConnector(CsvConnector)` at boot, and
ships a working connector without touching any other file.

---

## Phase 1.2 — Platform Management Architecture

### Purpose

Define the *platform management* surface — every feature a Platform
Admin or Tenant Admin will eventually use — as fail-closed route
shells and middleware stubs.

### Goals

- Every planned route mounted under `/api/v1`, returning `501` with a
  `hint` to the owning module README.
- Every planned security middleware stub fails closed (returns `501`).
- Module folders exist with `README.md` + `STATUS.md` so each sprint
  has a home.

### Deliverables

- All `src/routes/*.routes.js` files
- All fail-closed middleware stubs in `src/middleware/`
- All module folders under `src/modules/` with READMEs
- Per-module `STATUS.md` files (added in Sprint 0)

### Dependencies

Phase 1, Phase 1.1.

### Completion Criteria

- `curl -i http://localhost:8080/api/v1/<any-known-stub>` returns
  `501` with `hint`.
- `curl -i http://localhost:8080/api/v1/<unknown>` returns `404`.
- `npm run ci:guards` passes.

### Current Status

`Completed`. All stubs are in place and `check-routes` enforces the
discipline.

### Expected Outcome

A complete *route skeleton* that any future sprint fills in without
touching `app.js`, `server.js` or the route mounting logic.

---

## Phase 2 — Implementation (Sprints 0–9)

### Purpose

Deliver the MVP: a customer can sign up, invite users, connect data,
build dashboards, share reports and embed widgets — all on a
production-grade, multi-tenant backend.

### Goals

- Real authentication (User + Admin portals).
- Real IAM (admins, tenants, users).
- Real RBAC (modules, permissions, roles).
- Real master data (countries, currencies, timezones, plans, languages).
- Real platform configuration (settings, feature flags, notifications).
- Real connectors (CSV + Webhook in MVP).
- Real governance (audit, access, compliance).
- Real monitoring + support.
- Real analytics + embed.

### Deliverables

Ten sprints — see [`phases/sprint-0.md`](./phases/sprint-0.md) →
[`phases/sprint-9.md`](./phases/sprint-9.md).

### Dependencies

Phase 1, Phase 1.1, Phase 1.2.

### Sprint Dependency Graph

```
Sprint 0 (Foundation — shared utilities, drivers, plugins)
    └── Sprint 1 (Authentication)
        └── Sprint 2 (IAM + RBAC)
            └── Sprint 3 (Multi-Tenancy)
                ├── Sprint 4 (Connector Platform: CSV + Webhook)
                ├── Sprint 5 (Analytics Engine + Master Data — re-scoped)
                ├── Sprint 6 (Dashboards & Widgets — re-scoped)
                ├── Sprint 7 (Reports, Alerts, Notifications & Scheduling — re-scoped from Governance; ✅ complete)
                │   ├── Sprint 8 (Monitoring + Support + Governance surfaces)
                │   └── Sprint 9 (Analytics + Embed)
```

### Completion Criteria

- A user can: sign up → invite teammate → connect CSV → build
  dashboard → share report → embed widget → revoke their session.
- Every business endpoint has auth + tenant isolation + RBAC.
- 90 %+ test coverage on the touched surfaces.
- `npm run ci:guards` passes; `npm audit` reports 0 vulnerabilities.

### Current Status

`In Progress`. Sprints 0-3 are ✅ complete (see [`STATUS.md`](./STATUS.md)). Sprints 4-9 are 🕑 planned (see [`phases/`](./phases/README.md)).

### Expected Outcome

A production-grade multi-tenant SaaS analytics platform that a small
team can ship to paying customers. All enterprise features are
deferred to Phase 3 with hooks already in place.

---

## Phase 3 — Enterprise Features (Future)

### Purpose

Add the features that enterprise customers demand: KMS-managed keys,
WebAuthn / passkey authentication, multi-region, SIEM forwarders,
cold archival of audit logs, hash-chain tamper evidence, OAuth / SAML
SSO, SCIM 2.0, the MongoDB / Google Sheets / push / outbound-webhook
connectors, PDF / XLSX reports, anomaly detection and Prometheus
`/metrics`.

### Goals

Each item below ships with the same Definition of Done as a Phase 2
sprint (tests + docs + CI guard updates).

### Deliverables (planned)

- KMS-managed encryption keys (swap point already in
  [`utils/encryption.js`](../../src/utils/encryption.js))
- WebAuthn / passkey auth for admins (TOTP ships in Sprint 1)
- OAuth 2.0 / OpenID Connect + SAML SSO providers
- SCIM 2.0 user provisioning
- Multi-region deployment (active/active or warm standby)
- SIEM forwarder (`audit` events to Splunk / Datadog / Elastic)
- Cold archival to S3 (`audit` + `access` past retention window)
- Hash-chain tamper evidence on `audit`
- Public compliance endpoint via signed token
- MongoDB connector (read-only by default)
- Google Sheets connector (OAuth + service account)
- Push notifications (`push` channel in notifications)
- Outbound webhook notifications (`webhook` channel)
- PDF + XLSX report outputs (CSV ships in Sprint 9)
- Anomaly detection cron (`jobs/anomaly.job.js` becomes real)
- Prometheus `/metrics` endpoint

### Dependencies

Phase 2 complete.

### Completion Criteria

- Each deliverable ships with tests, docs and CI guard updates.
- Backward compatibility with Phase 2 is preserved (no breaking API
  changes for existing customers).

### Current Status

`Future`. Hook points for every item already exist in the
codebase; see [`DECISIONS.md`](./DECISIONS.md#postponed-decisions-phase-3).

### Expected Outcome

A platform that enterprise procurement teams approve: SSO, SCIM,
audit retention, KMS, multi-region.

---

## Phase 4 — Advanced Enterprise (Future)

### Purpose

Push the platform further into enterprise territory: data residency
per tenant, custom domains, dedicated clusters, on-prem install
options.

### Goals

Each item below ships with the same Definition of Done as Phase 2
sprints.

### Deliverables (planned)

- KMS-managed encryption keys hardened (Phase 3 introduces the swap;
  Phase 4 retires the env-key fallback).
- Multi-region active/active deployment.
- Data residency per tenant (e.g. EU-only tenants stored on
  EU-resident MongoDB cluster).
- Custom-domain tenant routing (`resolveTenant` middleware learns to
  parse subdomains).
- White-label branding.

### Dependencies

Phase 3 complete.

### Completion Criteria

- Per-tenant data-residency tests pass.
- Custom-domain routing works end-to-end with valid TLS.

### Current Status

`Future`. The hooks for per-tenant encryption contexts already exist
in [`utils/encryption.js`](../../src/utils/encryption.js).

### Expected Outcome

The platform is competitive with Looker, Tableau and Mode in
enterprise procurement scenarios.

---

## Phase 5 — Mobile Apps & SDKs (Future, exploratory)

### Purpose

Native mobile applications and official SDKs for the most popular
languages.

### Goals

Deliver a first-class mobile experience and reduce integration cost
for partners.

### Deliverables (planned, exploratory)

- iOS and Android apps (React Native or native).
- Official SDKs for JavaScript, Python, Go.
- Push notifications via APNs / FCM (Phase 3 ships the platform
  plumbing).

### Dependencies

Phase 3 complete (push notifications, OAuth).

### Completion Criteria

- iOS and Android apps ship to TestFlight and internal track.
- SDKs have documentation and a working example app.

### Current Status

`Future`. The architecture supports mobile-friendly JWT auth + refresh
rotation already (see [`backend/authentication.md`](./backend/authentication.md) once it lands).

### Expected Outcome

The platform is usable from any client, anywhere.

---

## Phase 6 — AI / ML Features (Future, exploratory)

### Purpose

Use the data the platform already collects to surface insights
automatically.

### Goals

Reduce the work an analyst has to do by hand.

### Deliverables (planned, exploratory)

- Anomaly detection on metric series (extends the `anomaly.job.js`
  stub).
- Smart alert routing ("this alert is similar to three previous
  alerts, suppress").
- Natural-language query interface ("show me revenue by region last
  quarter").
- Auto-generated dashboard layouts.

### Dependencies

Phase 2 has shipped enough data volume to train on.

### Completion Criteria

- Each deliverable has accuracy / recall metrics published in the
  docs.
- Each deliverable degrades gracefully when the model is unavailable
  (returns the same response as today).

### Current Status

`Future`. The `jobs/anomaly.job.js` cron slot is reserved and disabled
by default.

### Expected Outcome

The platform becomes self-driving for the most common analytics use
cases.

---

## Phase 7 — White-label / Multi-operator (Future, exploratory)

### Purpose

Let other companies operate their own SaaS analytics platforms on
top of this codebase.

### Goals

A single deployment can host many *operators*, each with their own
tenants, branding and billing.

### Deliverables (planned, exploratory)

- Operator hierarchy (super-admin > operator > tenant).
- Per-operator branding (logo, colours, email templates).
- Per-operator billing isolation.
- Operator marketplace for connectors.

### Dependencies

Phase 4 (custom domains, data residency).

### Completion Criteria

- Two operators can co-exist on one deployment with zero leakage.
- A partner can deploy the platform under their own brand with no
  code changes.

### Current Status

`Future`. This is the longest-horizon item; we do not have concrete
sprint plans.

### Expected Outcome

The codebase becomes a platform for platforms.

---

## Cross-Phase Concerns

These are not a single phase's responsibility; every phase keeps
them in mind.

| Concern | Owner | Where it lives |
| --- | --- | --- |
| **Security** | Every engineer | [`backend/security.md`](./backend/security.md) (planned) |
| **Scalability** | Tech lead | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| **Observability** | Platform team | [`backend/monitoring.md`](./backend/monitoring.md) (planned) |
| **Documentation** | Every engineer | [`TEMPLATE.md`](./TEMPLATE.md) + [`STATUS.md`](./STATUS.md) |
| **Compliance** | Legal + Engineering | [`backend/`](./backend/) (planned) |

---

## How This Roadmap Stays Current

1. Every sprint closure PR updates:
   - The matching row in *Phase Status* above.
   - The matching row in [`STATUS.md`](./STATUS.md) *Sprint Log*.
   - The matching entry in [repo-root `CHANGELOG.md`](../../CHANGELOG.md).
2. Every phase status change (e.g. *Phase 2 → Completed*) updates
   the matching *Completion* cell.
3. The CI guard `check-readme-sync` verifies that the root docs and
   every module `STATUS.md` exist; freshness is a manual discipline.

---

## Summary

The roadmap is seven phases deep and three years wide. Phase 1 and
Phase 1.1 and Phase 1.2 are complete; Phase 2 is in flight (Sprints 0-3
done, Sprint 4 in progress, Sprints 5-9 planned); Phase 3+ is future. The order is
non-negotiable: foundation, then auth, then IAM/RBAC, then multi-tenancy, then
connectors, platform config, master data, governance, monitoring, and
analytics + embed. Every deliverable is traceable back to a sprint plan in `phases/`.

## Key Takeaways

- **Three phases complete, one in flight, four future.**
- **Sprints 0-6 are the seven completed sprints of ten** in Phase 2
- **Phase 3+ items already have hooks in the code** (KMS swap,
  audit events, public compliance endpoint shape). They are not
  rewrites; they are slot-fills.
- **The dependency graph is strict** — do not skip ahead.
- **The Definition of Done is the same for every sprint**: tests,
  docs, CI guard updates.

## Interview Preparation

### Common Questions

- "Walk me through how you scope a multi-year project."
- "Why does Phase 2 take ten sprints instead of three?"
- "How do you decide what to defer to Phase 3?"
- "What is the cost of skipping a phase?"

### Sample Answers

- **"How do you scope a multi-year project?"** — Start from the
  business vision, derive the smallest MVP that delivers it, slice
  that MVP into phases by *layer* (foundation → IAM → RBAC →
  business → enterprise), then slice each phase into sprints by
  *vertical slice* (model → repo → service → controller → route →
  test). A phase is complete when a user-visible workflow runs end
  to end.

- **"Why ten sprints for Phase 2?"** — Because each sprint ships a
  *complete* feature, not a partial one. Sprint 1 ships the entire
  login flow or nothing; Sprint 3 ships the entire RBAC engine or
  nothing. Splitting further would mean half-finished features that
  cannot be demoed.

- **"How do you decide what to defer?"** — Anything whose omission
  does not block the MVP demo. KMS is not needed to demo a login
  flow; OAuth SSO is not needed to demo an RBAC engine; multi-region
  is not needed to demo a CSV ingest. Every deferral keeps an
  architectural hook so the eventual implementation is a slot-fill,
  not a rewrite.

- **"What is the cost of skipping a phase?"** — Skipping Phase 1.1
  (the connector framework) means Sprint 6 ships four vendor SDK
  imports into business code instead of one. Skipping Phase 1.2 (the
  fail-closed stubs) means a new contributor can accidentally let
  traffic through an unfinished auth check. Skipping Phase 2 Sprint
  0 (the shared implementation) means Sprint 1 re-implements
  encryption, JWT and password hashing under deadline pressure. Every
  shortcut compounds.

### Real-World Examples

- A founder asks "can we ship Phase 3 in three months?" The answer
  from this document is *no, Phase 2 ships ten sprints first, the
  hooks are already there but the implementation lands after we have
  paying customers validating the MVP*. They negotiate accordingly.
- A new engineer is asked "what am I doing this week?" They open
  [`STATUS.md`](./STATUS.md) → `Current Development` and see
  *Sprint 1 — Authentication*. They open
  [`phases/sprint-1.md`](./phases/sprint-1.md) for the deliverables.

### Common Mistakes

- Treating *Planned* and *Future* as the same. Phase 2 sprints are
  *Planned* (designed, scoped, ready to start). Phase 3+ items are
  *Future* (no sprint plan exists).
- Promising Phase 3 dates in customer contracts. The roadmap is a
  planning instrument for the team, not a sales commitment.
- Skipping Phase 1 because "we already know what we are doing".
  The architecture rules Phase 1 ships are the same rules the CI
  guards enforce in every later sprint.

## Related Documents

- [`README.md`](./README.md) — documentation homepage
- [`STATUS.md`](./STATUS.md) — daily-read project state
- [`TEMPLATE.md`](./TEMPLATE.md) — the documentation standard
- [`01-getting-started.md`](./01-getting-started.md) — onboarding
- [`02-project-vision.md`](./02-project-vision.md) — the *why* behind
  every phase
- [`04-business-flow.md`](./04-business-flow.md) — end-to-end story
- [`05-user-journey.md`](./05-user-journey.md) — persona-by-persona
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture
- [`DECISIONS.md`](./DECISIONS.md) — every architectural decision
- [`phases/README.md`](./phases/README.md) — sprint index
- [Repo-root `CHANGELOG.md`](../../CHANGELOG.md) — chronological log

## Last Updated

- **Sprint:** Sprint 6 close (Dashboards & Widgets)
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-12
- **Author:** Engineering (Sprint 6 close, Sprint 5–6 re-scope)