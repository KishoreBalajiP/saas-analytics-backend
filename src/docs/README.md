# SaaS Analytics Platform — Engineering Documentation

> The single source of truth for engineers working on this codebase.
> Every document in this folder is anchored to the actual implementation
> in the repository. When implementation changes, the matching document
> changes in the same commit.

---

## At a Glance

| Field | Value |
| --- | --- |
| **Project** | Multi-tenant SaaS analytics platform |
| **Repository** | `saas-analytics-backend` (Node.js / Express 5 / Mongoose 8) |
| **Current version** | `1.0.0` |
| **Current phase** | **Phase 2** |
| **Current sprint** | **Sprint 0 — complete** |
| **Next sprint** | **Sprint 1 — Authentication** |
| **Overall completion** | **~15 %** (architecture + foundation only; no business features yet) |
| **Current milestone** | Foundation locked; ready to start user-visible features |
| **Next milestone** | First end-to-end login → me → logout flow on both portals |

---

## What This Documentation Is

This is the **internal engineering handbook** of the SaaS Analytics Platform.
It is written for two audiences:

1. **New engineers** who need to become productive on the codebase without
   picking it up by trial-and-error.
2. **The team** (and the founding architect) who need a permanent knowledge
   base that survives turnover.

It is **not** marketing material, **not** a developer-portal API reference
(we ship OpenAPI for that), and **not** an external help center.

## What This Documentation Is Not

- **Not a substitute for the code.** Documents explain *why* and *how*;
  the source is the authority for *what*.
- **Not a forward-looking wishlist.** Planned work is explicitly marked
  `Planned`. We never describe future work as if it were already shipped.
- **Not duplicating `README.md` / `CHANGELOG.md` at the repo root.** Those
  are the public-facing home page and the chronological log; this folder
  is the engineering reference. They cross-reference each other.

---

## How to Use This Documentation

**If you just joined the team:** read in the order given under
[Learning Path](#learning-path). Stop at every *WHY?* paragraph and ask
yourself whether you would have made the same call. If the answer is no,
raise it — the ADRs are living documents.

**If you are about to implement a sprint:** open the matching
`phases/sprint-N.md`, read the *Scope*, *Deliverables*, *Dependencies*
and *Definition of Done*. Read every `Related Documents` link at the
bottom before writing code.

**If you are reviewing a PR:** every change should be traceable to a
document or an ADR. If it is not, either the change is wrong or the
documentation is. Update the document in the same PR.

**If you are preparing for an interview:** see the [`interview/`](./interview/)
folder — it is built from real interview questions answered with code
from this repository.

---

## Learning Path

A new engineer should read these documents in this order. Total time:
about half a day.

1. **[Getting Started](./01-getting-started.md)** — what this project is
   and how to run it locally.
2. **[Project Vision](./02-project-vision.md)** — *why* the platform
   exists and who it is for.
3. **[Product Roadmap](./03-product-roadmap.md)** — what the long-term
   journey looks like, phase by phase.
4. **[Business Flow](./04-business-flow.md)** — the canonical onboarding
   story, end to end.
5. **[User Journey](./05-user-journey.md)** — every persona, what they
   can do, what they cannot.
6. **[Status](./STATUS.md)** — what is done, in progress, planned,
   future.
7. **[Architecture](./ARCHITECTURE.md)** — the system, the layers,
   the lifecycle of a request.
8. **[Backend](./backend/README.md)** — feature-by-feature reference for
   every backend concern.
9. **[Development](./development/README.md)** — coding standards, testing
   strategy, deployment, definition of done.
10. **[Phases](./phases/README.md)** — the sprint log.
11. **[ADR](./adr/README.md)** — the architectural decisions we made
    and why.
12. **[Glossary](./glossary/README.md)** — every term explained in plain
    English.
13. **[Interview](./interview/README.md)** — interview prep on real
    questions answered with this code.

> **Rule of thumb:** if you can explain every numbered *WHY* in those
> documents to a colleague without looking at the source, you are ready
> to start contributing.

---

## Documentation Index

### Foundation

| # | Document | Purpose |
| - | --- | --- |
| — | [Template](./TEMPLATE.md) | The 15-section standard every new document MUST follow |
| 1 | [Getting Started](./01-getting-started.md) | Onboarding: prerequisites, install, run, verify |
| 2 | [Project Vision](./02-project-vision.md) | Business vision, target customers, competitive position |
| 3 | [Product Roadmap](./03-product-roadmap.md) | Phase 1 → Phase 7 with deliverables, status, dependencies |
| 4 | [Business Flow](./04-business-flow.md) | End-to-end onboarding of a fictional customer |
| 5 | [User Journey](./05-user-journey.md) | Persona-by-persona capabilities and limits |
| — | [Status](./STATUS.md) | Single source of truth for project state |

### Architecture (technical reference)

| Document | Purpose |
| --- | --- |
| [Architecture (Sprint 0 system diagram + request lifecycle)](./ARCHITECTURE.md) | The big picture, in one diagram, and the request lifecycle. Authoritative technical reference. |

### Backend (`backend/`)

| Document | Purpose |
| --- | --- |
| [Backend home](./backend/README.md) | Index of every backend concern |
| [Authentication](./backend/authentication.md) | JWT, sessions, MFA, refresh-token rotation |
| [RBAC](./backend/rbac.md) | Dynamic roles and permissions model |
| [Multi-Tenancy](./backend/multi-tenancy.md) | How tenants are isolated and resolved |
| [Connectors](./backend/connectors.md) | The connector framework |
| [Queues](./backend/queues.md) | BullMQ + in-memory transport |
| [Cache](./backend/cache.md) | Redis + memory provider |
| [Storage](./backend/storage.md) | Local + S3 provider |
| [Database](./backend/database.md) | MongoDB + Mongoose conventions |
| [Security](./backend/security.md) | Threat model and controls |
| [Monitoring](./backend/monitoring.md) | Health probes and observability seams |
| [WebSockets](./backend/websockets.md) | Socket.IO room model |

### Development (`development/`)

| Document | Purpose |
| --- | --- |
| [Development home](./development/README.md) | Index |
| [Coding Standards](./development/coding-standards.md) | Lint, naming, file layout |
| [API Standards](./development/api-standards.md) | Error envelope, versioning, idempotency |
| [Testing Strategy](./development/testing-strategy.md) | How we test and what we test |
| [Git Workflow](./development/git-workflow.md) | Branches, commits, PR conventions |
| [Environment Setup](./development/environment-setup.md) | Every `env var` documented |
| [Deployment](./development/deployment.md) | Run on Render / Railway / Docker / ECS |
| [Definition of Done](./development/definition-of-done.md) | What "done" means |
| [Documentation Rules](./development/documentation-rules.md) | How we keep docs in sync with code |

### Phases (`phases/`)

| Document | Purpose |
| --- | --- |
| [Phases home](./phases/README.md) | Index of every phase and sprint |
| [Phase 1](./phases/phase-1.md) | Production backend foundation (complete) |
| [Phase 1.1](./phases/phase-1.1.md) | Connector & infrastructure architecture (complete) |
| [Phase 1.2](./phases/phase-1.2.md) | Platform management architecture (complete) |
| [Phase 2](./phases/phase-2.md) | Implementation — Sprints 0–9 (in progress) |
| [Sprint 0](./phases/sprint-0.md) | Shared implementation foundation (complete) |
| [Sprint 1](./phases/sprint-1.md) | Authentication (complete) |
| [Sprint 2](./phases/sprint-2.md) | IAM — admins, tenants, users, RBAC (complete) |
| [Sprint 3](./phases/sprint-3.md) | Multi-Tenancy — tenant lifecycle, onboarding, settings, feature flags (complete) |
| [Sprint 4](./phases/sprint-4.md) | Connector Platform — CSV + Webhook connectors, sync engine (in progress) |
| [Sprint 5](./phases/sprint-5.md) | Platform: settings surface, feature flags surface, notifications (planned) |
| [Sprint 6](./phases/sprint-6.md) | Master Data — countries, currencies, timezones, plans, languages (planned) |
| [Sprint 7](./phases/sprint-7.md) | Governance: audit, access, compliance (planned) |
| [Sprint 8](./phases/sprint-8.md) | Monitoring + Support (planned) |
| [Sprint 9](./phases/sprint-9.md) | Analytics + Embed (planned) |
| [Phase 3](./phases/phase-3.md) | Enterprise features (future) |
| [Phase 4](./phases/phase-4.md) | KMS, WebAuthn, multi-region (future) |
| [Phase 5](./phases/phase-5.md) | Mobile apps & SDKs (future, exploratory) |
| [Phase 6](./phases/phase-6.md) | AI / ML features (future, exploratory) |
| [Phase 7](./phases/phase-7.md) | White-label / multi-operator (future, exploratory) |

### ADR (`adr/`)

| Document | Purpose |
| --- | --- |
| [ADR home](./adr/README.md) | How to read and add ADRs |
| [ADR-001](./adr/ADR-001-jose-for-jwt.md) | `jose` for JWT |
| [ADR-002](./adr/ADR-002-argon2id-for-passwords.md) | Argon2id for password hashing |
| [ADR-003](./adr/ADR-003-in-memory-cache-default.md) | In-memory cache default, Redis when `REDIS_URL` is set |
| [ADR-004](./adr/ADR-004-bullmq-for-queues.md) | BullMQ for durable queue transport |
| [ADR-005](./adr/ADR-005-s3-storage-abstraction.md) | S3-compatible storage abstraction |
| [ADR-006](./adr/ADR-006-aes-256-gcm-envelope.md) | AES-256-GCM envelope for at-rest encryption |
| [ADR-007](./adr/ADR-007-shared-mongoose-plugins.md) | Five shared Mongoose plugins |
| [ADR-008](./adr/ADR-008-idempotency-middleware.md) | Idempotency middleware with cached outcomes |
| [ADR-009](./adr/ADR-009-service-wrappers.md) | Service-wrapper abstraction for infrastructure |
| [ADR-010](./adr/ADR-010-ci-guardrails.md) | Five CI guardrails |

### Interview (`interview/`)

| Document | Purpose |
| --- | --- |
| [Interview home](./interview/README.md) | How to use this folder; topic-by-topic prep notes (per-topic docs land as the topic's domain deepens). |

### Glossary (`glossary/`)

| Document | Purpose |
| --- | --- |
| [Glossary](./glossary/README.md) | Plain-English definitions of every term |

---

## Existing Documents We Do Not Duplicate

These live at the repository root and at the top of `src/docs/`. We
reference them rather than re-create them.

| Location | File | Why it stays there |
| --- | --- | --- |
| repo root | `README.md` | Public-facing project home |
| repo root | `CHANGELOG.md` | Chronological change log |
| `src/docs/` | `ARCHITECTURE.md` | Sprint 0 system diagram + request lifecycle |
| `src/docs/` | `DECISIONS.md` | Sprint 0 ADRs (numbered ADR-001 → ADR-010) |
| `src/docs/` | `errors.md` | Error envelope contract + code catalogue |
| `src/models/plugins/` | `README.md` | Plugin usage guide |
| `src/modules/<feature>/` | `README.md` + `STATUS.md` | Per-module contracts and status |

When the new folder is fully built, these become the deep technical
reference and the engineering handbook becomes the readable narrative on
top of them. Every document cross-links to the others where they overlap.

---

## Implementation Status Convention

Every document uses the same status labels so a reader never has to guess
what is real and what is promised:

| Label | Meaning |
| --- | --- |
| **Implemented** | Code is in the repository and tested. |
| **Partial** | Some surface area shipped; the rest is planned. The doc names both. |
| **Stub (fail-closed)** | Returns `501` until the sprint that implements it lands. |
| **Planned** | Documented and scheduled; not yet implemented. |
| **Future** | Discussed, not scheduled. Cannot be cited as a deliverable. |

The canonical status of every component lives in
[`STATUS.md`](./STATUS.md).

---

## Maintenance Rules

1. **Documentation changes ship with the code** that makes them true.
2. Every cross-reference is a real link. If you rename a file, fix every
   link to it.
3. Diagrams are ASCII-first. They render in every terminal, every IDE,
   every GitHub view.
4. Examples in the docs must be examples that *actually run* against the
   code. No pseudocode masquerading as code.
5. When the implementation changes and the docs disagree, **the docs are
   wrong**. Open a PR that fixes them.
6. **Every new document follows the canonical template** in
   [`TEMPLATE.md`](./TEMPLATE.md). The 15-section structure is
   mandatory; see that file for what is required vs. when relevant.