# 02 — Project Vision

## Purpose

> **WHAT this is:** the *why* behind the SaaS Analytics Platform.
> **WHY it exists:** engineers who only know the *what* make poor
> trade-offs. Knowing the vision lets you evaluate a feature request
> against the platform's purpose.
> **HOW to use it:** read it once at onboarding, then re-read it
> whenever you feel a sprint plan is missing the point.
> **WHEN to update it:** when the business positioning shifts
> materially. **Not** updated when features land — that belongs in
> `03-product-roadmap.md` and `CHANGELOG.md`.
> **WHERE it lives:** `src/docs/02-project-vision.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **New backend engineer** | Knows *why* the platform exists, not just *what* it does. |
| **Product manager** | Has the canonical statement to anchor roadmap discussions. |
| **Tech lead** | Has the yardstick for evaluating "should we build X?". |
| **Sales / founder** | Has the consistent positioning language for external communication. |
| **Interview candidate** | Has a single document to read before answering "tell me about the product". |

## Current Status

> **Status:** `Completed` — the vision is settled at Sprint 0 close and
> will only be revisited when business positioning shifts materially.
> **Sprint:** Sprint 0 close (no further updates expected unless
> positioning changes).
> **Owner:** Founding architect.

---

## What Are We Building?

We are building a **multi-tenant SaaS analytics platform** that gives
every customer company its own isolated workspace, lets that company
connect its data sources, build dashboards, share reports, and embed
widgets externally — while giving the *platform operator* (us) a
single pane of glass across every tenant.

Concretely, the backend is one Node.js service that exposes:

- A **Tenant Portal API** (`/auth/*`, `/tenants/*`, `/dashboards/*`,
  `/reports/*`) used by the customer company's end users.
- An **Admin Portal API** (`/admin-auth/*`, `/admin/admins/*`,
  `/tenants/*`, `/monitoring/*`, `/support/*`) used by our own
  operations team.
- A **public embed surface** (`/embed/*`) for dashboards shared
  outside the platform.
- A **connector surface** (`/connectors/*`, `/webhooks/*`) for data
  ingestion.

Every business surface is currently a fail-closed `501` until its
sprint lands — see [`STATUS.md`](./STATUS.md).

---

## Why Are We Building It?

The driving observation is that **analytics tools force a bad trade-off**:

- *Single-tenant per-deployment* tools (Tableau, Looker) are great
  for one company but make cross-tenant governance impossible.
- *Single-instance shared* tools (Metabase, Redash) make per-tenant
  isolation a manual, error-prone exercise.

A SaaS platform must do both: every tenant gets a fully isolated
workspace **and** the operator sees and governs all of them from one
console. That is the gap this codebase exists to fill.

### Business problems we solve

| Problem | How the platform solves it |
| --- | --- |
| Cross-tenant data leakage | `tenantScope` Mongoose plugin + `tenantIsolation` middleware + repository scoping (3 layers of defence). |
| Permission sprawl | Dynamic RBAC: roles are data, not code, and the permission key shape is `<module>.<action>`. |
| Vendor lock-in to a data source | `BaseConnector` contract + registry — CSV, Google Sheets, Webhooks, MongoDB all plug into the same pipeline. |
| Untraceable mutations | `audit` middleware captures every authenticated mutation; `accessLog` middleware captures every authenticated request. |
| Slow ingest blocking HTTP | Queues for connector sync, email and analytics jobs; HTTP returns immediately, work continues on a worker. |
| Fragile deployment | `degraded mode` boot + containerised health endpoint + graceful shutdown. |

### What we are *not* building (deferred)

- Real-time collaborative editing on dashboards (out of scope).
- Custom plugin marketplace (Phase 4+).
- WebAuthn / passkey auth (Phase 3+).
- KMS-managed encryption keys (Phase 3+).
- Multi-region active/active (Phase 4+).

See [`DECISIONS.md`](./DECISIONS.md) "Postponed Decisions" for the
full list with rationale.

---

## Long-Term Vision

In three years we want the platform to be the *default* analytics
back-end for mid-market companies that:

1. Have outgrown spreadsheets but do not want a single-tenant
   deployment.
2. Need their data to stay in their tenant — a regulatory or
   contractual requirement.
3. Connect to a mix of file uploads, SaaS exports and direct
   database sources.

To get there we are building in this order:

| Horizon | What it delivers |
| --- | --- |
| **Phase 2 — MVP** | Auth, RBAC, master data, CSV + Webhook ingestion, dashboards, CSV reports, signed embeds, governance, monitoring. |
| **Phase 3 — Enterprise features** | KMS, WebAuthn, multi-region, SIEM, hash-chain audit, cold archival, OAuth/SAML SSO, SCIM 2.0, MongoDB / Google Sheets connectors, push + outbound webhook notifications, PDF / XLSX reports, anomaly detection cron, Prometheus `/metrics`. |
| **Phase 4+ — Scale-out** | Data residency per tenant, connector marketplace, custom-domain tenant routing. |

The full plan lives in [`03-product-roadmap.md`](./03-product-roadmap.md).

---

## Target Customers

### Primary persona: mid-market analytics buyer

- 50–2 000 employees.
- 5–50 people who would use dashboards.
- Mix of CSVs (exports from operational tools), SaaS exports
  (Google Sheets, Stripe, HubSpot), and one or two production
  databases.
- Needs tenant isolation because of multi-region regulation or
  per-customer data residency.

### Secondary persona: SaaS companies embedding analytics

- 200+ employees.
- Need to ship *analytics for their own customers* under their own
  brand.
- Use the **embed** surface (`/embed/*`) to mount dashboards on
  their own dashboards without exposing the underlying data.

### Anti-persona: enterprise single-tenant deployments

- Customers who need a dedicated cluster, on-prem install, custom
  compliance attestations, or 24/7 named-support SLAs from day one.
- Phase 4+ is when those land. Until then, we point them elsewhere.

---

## How We Differ From Existing Tools

| Tool | What it is | Why this platform differs |
| --- | --- | --- |
| **Tableau / Looker** | Single-tenant BI suite | We are SaaS-native; every customer is a tenant from day one, no installation, no per-tenant ops burden. |
| **Metabase / Redash** | Open-source BI, single-instance | We have multi-tenant isolation enforced at the framework level, plus role-based RBAC for cross-tenant admin work. |
| **Mode / Hex** | Collaborative notebook-style BI | We optimise for *delivery* (signed embed widgets, scheduled CSV reports) rather than analyst exploration. |
| **Power BI Embedded** | Enterprise embed surface | We are not enterprise-priced; embed is a first-class citizen from day one. |

The differentiation is not "we have a chart library". It is
**multi-tenant SaaS with strong isolation, a connector framework, and
embeds — designed together, not bolted on**.

---

## Competitive Advantages (technical, not marketing)

These are advantages we earn by the way the code is structured, not
claims we make in a pitch deck:

1. **Three layers of tenant isolation.** `resolveTenant` (where does
   the request come from?), `tenantIsolation` (is this actor allowed
   to touch this resource?), `tenantScope` plugin (does the query
   filter on `tenantId`?). Forgetting one is a bug, not a security
   incident.
2. **Connector framework with a registry.** Adding a new provider is a
   single file (`BaseConnector` subclass) registered at boot. Business
   code never imports a vendor SDK.
3. **Fail-closed by default.** Every unimplemented security middleware
   returns `501`. A new contributor cannot accidentally let traffic
   through an unfinished auth check.
4. **Service-wrappers for infrastructure.** Feature code never imports
   `ioredis`, `bullmq`, `@aws-sdk/client-s3` or `nodemailer`. Switching
   providers (e.g. SQS instead of BullMQ) is a one-file change.
5. **CI guardrails that match the architecture rules.** Every rule in
   `ARCHITECTURE.md` has a script under `scripts/ci/` that fails the
   build when the rule is broken.

---

## How the Vision Translates Into Code

The vision is not a slide; it is a set of decisions that shaped the
code. Each row below links the business goal to the architectural
choice.

| Business goal | Code decision | Where it lives |
| --- | --- | --- |
| "Tenants must never see each other's data" | `tenantScope` plugin + `tenantIsolation` middleware + repo scoping | [`src/models/plugins/tenantScope.js`](../../src/models/plugins/tenantScope.js) · [`src/middleware/tenantIsolation.middleware.js`](../../src/middleware/tenantIsolation.middleware.js) |
| "Adding a new data source should not require a refactor" | `BaseConnector` + registry | [`src/connectors/BaseConnector.js`](../../src/connectors/BaseConnector.js) · [`src/connectors/ConnectorRegistry.js`](../../src/connectors/ConnectorRegistry.js) |
| "Security middleware must never be silently skipped" | Every stub middleware returns `501` via `ApiError.notImplemented()` | [`src/middleware/auth.middleware.js`](../../src/middleware/auth.middleware.js) · [`src/utils/ApiError.js`](../../src/utils/ApiError.js) |
| "Switching infra provider should not be a refactor" | Service wrappers + provider selection via config | [`src/services/`](../../src/services/) |
| "Architecture rules must be enforced" | CI guard scripts under `scripts/ci/` | [`scripts/ci/`](../../scripts/ci/) |
| "Every mutation must be auditable" | `audit` plugin + Sprint 8 consumer (originally Sprint 7, re-scoped — see [`phases/sprint-7.md`](./phases/sprint-7.md)) | [`src/models/plugins/audit.js`](../../src/models/plugins/audit.js) |
| "Retries must not cause duplicate writes" | `idempotency` middleware + cached outcomes | [`src/middleware/idempotency.middleware.js`](../../src/middleware/idempotency.middleware.js) |
| "The same code must run anywhere" | `degraded mode` boot + platform-agnostic `server.js` | [`src/server.js`](../../src/server.js) |

---

## How a New Engineer Should Use This Document

Read it once at onboarding (Stage 1 in
[`01-getting-started.md`](./01-getting-started.md#stage-1--see-it-run--30-min)).
Then, whenever you find yourself asking *"should I implement this
feature this way?"* come back here and ask *"does this serve any of
the three business goals above?"*. If the answer is no, push back on
the feature; if yes, the implementation pattern usually follows.

---

## What This Document Is Not

- Not a marketing one-pager. It does not describe pricing, GTM or
  brand voice.
- Not a sales playbook. The differentiation is stated as technical
  facts, not aspirational claims.
- Not an aspirational wishlist. "We will have KMS-managed keys in
  2027" is in Phase 3 docs; it is *not* here.

---

## Summary

The SaaS Analytics Platform exists because existing BI tools force
customers into a single-tenant-or-shared-instance trade-off. We do
both: every tenant gets an isolated workspace while the operator
governs all of them from one console. We earn that promise through
three-layer tenant isolation, a connector framework, fail-closed
middleware, service-wrapper infrastructure, and CI guardrails that
match the architecture rules.

## Key Takeaways

- **Why we exist:** the multi-tenant SaaS analytics gap in the market.
- **What we sell:** isolated workspaces + operator governance +
  connector-driven ingestion + embed.
- **How the code serves the vision:** each architectural decision in
  `DECISIONS.md` maps to one of the business goals above.
- **What we defer:** KMS, WebAuthn, multi-region, hash-chain audit,
  SCIM, OAuth/SAML SSO — all Phase 3+ with hooks already in place.

## Interview Preparation

### Common Questions

- "Tell me about a product you helped design — what was the core
  problem?"
- "How would you explain the difference between SaaS analytics and
  self-hosted BI?"
- "What is *multi-tenant isolation* and how would you defend against
  cross-tenant leakage?"
- "Why would you build a connector framework instead of integrating
  one vendor SDK per source?"
- "What's the difference between a *product vision* document and a
  *roadmap*?"

### Sample Answers

- **"What was the core problem?"** — Mid-market customers outgrow
  spreadsheets but cannot afford single-tenant BI infra. Shared
  tools do not isolate tenants properly. We fill the gap: full
  isolation per tenant, single operator console across all tenants.

- **"Multi-tenant isolation — how do you defend against leakage?"** —
  Three layers. (1) `resolveTenant` middleware decides which tenant
  the request belongs to (priority: header → JWT claim → subdomain).
  (2) `tenantIsolation` middleware checks the actor is allowed to
  touch that tenant's resources. (3) The `tenantScope` Mongoose
  plugin auto-injects the tenant filter on every read, and refuses
  to save a document without `tenantId`. Forgetting any one is a
  bug, not a security incident — the others still catch it.

- **"Why a connector framework?"** — A vendor SDK in business code
  couples the platform to that vendor. With a `BaseConnector`
  contract + a registry, adding Sheets, MongoDB or BigQuery is a
  single new class registered at boot. Business code never imports
  `googleapis` or `mongodb`. This makes connector pricing, outages
  and deprecations a contained problem.

- **"Vision vs roadmap?"** — Vision is *why we exist and what we
  promise*. It changes rarely and is not feature-shaped. Roadmap is
  *what we are shipping in which phase*, with deliverables and
  status. Vision stays at 1 page; roadmap grows every sprint.

### Real-World Examples

- A platform engineer asks: "should we add a `process.env` reading
  in the new `iam` feature?" Answer: no, route it through
  `src/config/env.js`. The CI guard `check-config` blocks the PR;
  the architecture rule exists because we promised platform-agnostic
  deploys.
- A product manager asks: "can a `tenant_admin` see another tenant's
  audit log?" Answer: only with `tenantScope: '*'`, which only
  `support_admin` and `super_admin` hold. The vision (operator
  governance, not cross-tenant access by default) drove the rule.

### Common Mistakes

- Treating vision as marketing. It is engineering intent; every claim
  here must be defensible by code or by a planned sprint.
- Confusing vision with roadmap. If you find a *delivery date* here,
  it belongs in `03-product-roadmap.md` instead.
- Adding features that violate the vision (e.g. a per-deployment
  install mode) without first updating this document.

## Related Documents

- [`README.md`](./README.md) — documentation homepage
- [`STATUS.md`](./STATUS.md) — current project state
- [`01-getting-started.md`](./01-getting-started.md) — onboarding
- [`03-product-roadmap.md`](./03-product-roadmap.md) — phase-by-phase plan
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture
- [`DECISIONS.md`](./DECISIONS.md) — architectural decisions
- [`05-user-journey.md`](./05-user-journey.md) — persona-by-persona
- [Repo-root `README.md`](../../README.md) — public home page

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)