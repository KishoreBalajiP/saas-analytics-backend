# 01 — Getting Started

## Purpose

> **WHAT this is:** the onboarding document for a new engineer.
> **WHY it exists:** every engineer should be productive on the codebase
> within a day without depending on tribal knowledge.
> **HOW to use it:** read top-to-bottom the first time; revisit the
> *Day-One Checklist* whenever you set up a new workstation.
> **WHEN to update it:** when the prerequisites, install steps, or
> run commands change.
> **WHERE it lives:** `src/docs/01-getting-started.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **New backend engineer** | A working local environment in under an hour. |
| **New frontend / mobile engineer** | Enough context to call the API correctly and to know what is stubbed. |
| **Engineering manager / tech lead** | A baseline to check onboarding quality against. |
| **Interview candidate** | The "what is this codebase" answer they can give back to us. |

## Current Status

> **Status:** `Maintained` — the file is updated when prerequisites,
> install steps or run commands change.
> **Sprint:** Sprint 0 (complete). The document reflects the state
> delivered at Sprint 0 close.
> **Owner:** Engineering team.

---

## What Is This Project?

This repository is the backend for a **multi-tenant SaaS analytics
platform**. It lets a company:

1. Provision a *tenant* (their isolated workspace).
2. Invite users to that tenant.
3. Connect data sources (CSV uploads, webhook receivers — Google Sheets
   and MongoDB connectors are planned).
4. Build dashboards and reports over the connected data.
5. Share dashboards publicly via signed *embed* widgets.
6. Govern everything with role-based access, audit logs and compliance
   tooling.

The backend is a Node.js application built on Express 5, MongoDB via
Mongoose, Socket.IO for realtime, BullMQ on Redis for background work,
and an S3-compatible object store for files. It runs as a single
containerised process on Render, Railway, Docker or AWS ECS without
code changes.

The system is described in detail in
[`ARCHITECTURE.md`](./ARCHITECTURE.md). The current build state is in
[`STATUS.md`](./STATUS.md). Every architectural decision we have made
is in [`DECISIONS.md`](./DECISIONS.md). The why-we-are-building-this
story is in [`02-project-vision.md`](./02-project-vision.md).

---

## Why Are We Building It?

Three reasons, in order of importance:

1. **Customers are stuck.** Most analytics tools either force
   everything through a single shared dashboard (Tableau, Looker) or
   give every team its own silo they cannot govern centrally (Metabase,
   Redash). We give each tenant its own workspace *and* the operator
   a single pane of glass across all of them.
2. **Multi-tenant security is hard, and most teams get it wrong.** A
   tenant-scope Mongoose plugin, fail-closed auth middleware, and an
   idempotency layer are in place from Sprint 0 so future sprints can
   not accidentally leak data across tenants.
3. **Connectors should not couple the platform to a vendor.** A
   `BaseConnector` contract plus a registry means CSV, Google Sheets,
   webhooks and (later) MongoDB / BigQuery all plug into the same
   pipeline without business code knowing which SDK is in play.

The detailed business case and competitive positioning live in
[`02-project-vision.md`](./02-project-vision.md).

---

## Who Should Read This Document?

| Reader | What they get from this doc |
| --- | --- |
| **New backend engineer** | A working local environment in under an hour. |
| **New frontend / mobile engineer** | Enough context to call the API correctly and to know what is stubbed. |
| **Engineering manager / tech lead** | A baseline to check onboarding quality against. |
| **Interview candidate** | The "what is this codebase" answer they can give back to us. |

If you only have five minutes, jump to the [Day-One Checklist](#day-one-checklist)
and the [Architecture diagram](./ARCHITECTURE.md). If you have an hour,
read this document top-to-bottom and then [Project Vision](./02-project-vision.md).

---

## How Should a New Developer Learn This Project?

The codebase is large but the surface you need to know on day one is
small. We recommend a staged ramp-up. Do not skip stages — each one
unlocks the next.

### Stage 1 — See it run (≈ 30 min)

Goal: a working dev server and a passing test suite on your laptop.

1. Read the [Prerequisites](#prerequisites).
2. Run the [Quick Start](#quick-start).
3. Hit `GET /api/v1/health` and confirm the 200 response.
4. Run `npm test` and confirm the suite passes (124 tests; scrypt KDF mode).

### Stage 2 — Understand the skeleton (≈ 1 h)

Goal: be able to read the folder structure and know where new code
goes.

1. Read the folder tree in the repo-root [`README.md`](../../README.md)
   (the architecture rules are also documented there).
2. Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) — focus on the diagram
   and the *Request Lifecycle* section.
3. Read [`STATUS.md`](./STATUS.md) — know what is shipped, what is
   stubbed, what is coming.

### Stage 3 — Understand the rules (≈ 1 h)

Goal: know the conventions so your first PR does not bounce.

1. Read the **Architecture Rules** section of the repo-root
   [`README.md`](../../README.md).
2. Read [`DECISIONS.md`](./DECISIONS.md) — every choice has a *why*.
3. Run `npm run ci:guards` and read each script under
   `scripts/ci/` so you know what the machine enforces.

### Stage 4 — Pick a starter issue (≈ 2 h)

Goal: open and land your first PR.

1. Look at the *Next Deliverable* in
   [`STATUS.md`](./STATUS.md#current-development--read-this-first).
2. Open the matching sprint plan: [`Sprint 1`](./phases/sprint-1.md)
   (or whichever sprint is *Current*).
3. Pick the smallest *Deliverable* that does not depend on another
   one. Open a draft PR early.

### Stage 5 — Become an owner (≈ 1 week)

Goal: review someone else's PR and feel confident in your comments.

1. Read the [Development](./development/coding-standards.md) docs
   when they exist (planned in a later batch).
2. Read every per-module `README.md` under `src/modules/`.
3. Read [`03-product-roadmap.md`](./03-product-roadmap.md) so you can
   explain *why* Sprint N is on the schedule.

---

## Recommended Reading Order

```
 ┌─────────────────────────────────────────────────────────────┐
 │  Tier 1 — must read on day one (≈ 1 h total)                │
 │    1.  src/docs/01-getting-started.md (this file)            │
 │    2.  src/docs/STATUS.md   (Current Development section)    │
 │    3.  src/docs/ARCHITECTURE.md (diagram + request lifecycle)│
 │    4.  repo-root README.md  (tech stack + scripts)           │
 │    5.  src/docs/DECISIONS.md (the 10 Sprint 0 ADRs)          │
 └─────────────────────────────────────────────────────────────┘
                                 ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Tier 2 — must read before your first PR (≈ 1 h)            │
 │    6.  src/docs/02-project-vision.md                         │
 │    7.  src/docs/03-product-roadmap.md                        │
 │    8.  src/docs/phases/sprint-<current>.md                   │
 │    9.  src/docs/errors.md                                   │
 │   10.  The CI guard scripts under scripts/ci/               │
 └─────────────────────────────────────────────────────────────┘
                                 ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Tier 3 — read when you have a specific question             │
 │    • 04-business-flow.md, 05-user-journey.md                 │
 │    • backend/<feature>.md (auth, RBAC, multi-tenancy, …)    │
 │    • adr/ADR-NNN-… for any choice you want to challenge      │
 │    • glossary/README.md for any term you do not recognise    │
 │    • interview/<topic>.md for interview prep                 │
 └─────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

To run the project locally you need:

| Tool | Version | Why | Install |
| --- | --- | --- | --- |
| **Node.js** | `>= 20.0.0` (LTS) | Runtime — declared in `package.json#engines` | `nvm install --lts` or [nodejs.org](https://nodejs.org) |
| **npm** | bundled with Node | Package manager | already installed |
| **Git** | any recent | Version control | [git-scm.com](https://git-scm.com) |
| **MongoDB** *(optional)* | 6.x or 7.x | Persistent storage. The server boots in *degraded mode* without it so you can develop without Mongo running. | Docker (`docker compose up mongo`) or [mongodb.com](https://www.mongodb.com) |
| **Redis** *(optional)* | 7.x | Cache + queue transport + rate-limit storage. The server falls back to in-memory cache + in-memory queue when unset. | Docker or [redis.io](https://redis.io) |
| **Docker + Docker Compose** *(optional)* | any recent | Easiest way to get MongoDB + Redis up locally | [docker.com](https://docker.com) |

> **Nothing is strictly required except Node 20+.**
> The whole Sprint 0 surface (utilities, cache, queue, storage, email,
> plugins, CI) is testable with `npm test` alone — it boots an
> ephemeral MongoDB via `mongodb-memory-server` for the integration
> tests.

---

## Quick Start

The shortest path to a working dev server. Copy/paste this block into
your terminal at the repository root.

```bash
# 1. Clone and enter the project.
git clone <repo-url> saas-analytics-backend
cd saas-analytics-backend

# 2. Install dependencies (downloads everything; first run ≈ 60 s).
npm install

# 3. Copy the example env file. The defaults are safe for local dev.
cp .env.example .env

# 4. Start the dev server (nodemon watches src/ for changes).
npm run dev
```

At this point the server is running on `http://localhost:8080` and
prints:

```
INFO: Socket.IO initialised
INFO: SaaS Analytics Platform is running
    port: 8080
    version: "1.0.0"
```

> **Note:** with no MongoDB and no Redis configured, the server logs
> `Running in DEGRADED mode: database is unavailable`. This is
> expected. `/api/v1/health` still works.

### Verify it works

```bash
# Health endpoint.
curl http://localhost:8080/api/v1/health
# → 200 with the standard envelope; data.db === 'disconnected' is OK.

# A real auth endpoint. Invalid credentials → 401 with a GENERIC message
# (no user enumeration). Needs a valid tenant header for a real login.
curl -i -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: tnt_000000000000000000000000" \
  -d '{"email":"a@b.c","password":"x"}'
# → 401, body contains `"message":"Invalid email or password"`.

# Unknown route → 404.
curl -i http://localhost:8080/api/v1/does-not-exist
# → 404 with the standard error envelope.
```

### Run the tests

```bash
# Full suite (≈ 3 s on a warm cache, longer on first run while
# mongodb-memory-server downloads a MongoDB binary). Runs in scrypt
# KDF mode so it is portable on any machine.
npm test

# Same suite against the real Argon2id KDF.
npm run test:argon2
```

You should see `124 pass, 0 fail`.

### Run the CI guardrails

```bash
# The same checks that gate merges.
npm run ci:guards
```

You should see all five guards report `OK`.

---

## Day-One Checklist

Use this on every new workstation.

- [ ] Node `>= 20` installed (`node -v`).
- [ ] Repo cloned and `npm install` completed.
- [ ] `.env` copied from `.env.example`.
- [ ] `npm run dev` starts the server on port 8080.
- [ ] `curl /api/v1/health` returns 200.
- [ ] `curl POST /api/v1/auth/login` returns a structured error envelope
      (real endpoint; invalid credentials → 401, generic message).
- [ ] `npm test` reports 124 / 124 pass.
- [ ] `npm run ci:guards` reports 5 / 5 OK.
- [ ] I have read [`STATUS.md`](./STATUS.md) — *Current Development*
      section.
- [ ] I have read [`ARCHITECTURE.md`](./ARCHITECTURE.md) — diagram and
      request lifecycle.
- [ ] I have read [`DECISIONS.md`](./DECISIONS.md) — all 10 ADRs.
- [ ] I know which [sprint](./phases/) is current and which is next.

---

## Optional: Full Local Stack (MongoDB + Redis + App)

If you want a fully wired local environment rather than the degraded
mode used by the quick start:

```bash
# 1. Make sure Docker Desktop is running.
docker --version

# 2. Start MongoDB + Redis + the app via the repo's compose file.
docker compose up --build
```

This will:

- Run MongoDB 7 on port 27017.
- Run the app on port 8080.
- Skip Redis by default — the cache + queue fall back to in-memory.
  Add `REDIS_URL=redis://…` to `.env` if you want to exercise the
  Redis-backed code path.

To also run Redis locally:

```bash
docker run --rm -d --name saas-redis -p 6379:6379 redis:7-alpine
# Then add REDIS_URL=redis://127.0.0.1:6379 to .env and restart the app.
```

---

## Where to Get Help

| Question | Where to look |
| --- | --- |
| "Where does new code go?" | [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`STATUS.md`](./STATUS.md) |
| "Why was X chosen over Y?" | [`DECISIONS.md`](./DECISIONS.md) |
| "What does this term mean?" | [`glossary/README.md`](./glossary/README.md) |
| "What's the next sprint?" | [`STATUS.md`](./STATUS.md#current-development--read-this-first) |
| "How do I review this PR?" | [`development/definition-of-done.md`](./development/definition-of-done.md) (planned) |
| "I think the docs are wrong" | Open a PR that fixes them. The docs are living; see [Documentation Rules](./development/documentation-rules.md) (planned). |

---

## Common First-Day Mistakes (and how to avoid them)

| Mistake | Fix |
| --- | --- |
| Reading `process.env` from a feature file | Don't. Go through `src/config/env.js`. The CI guard [`check-config`](../../scripts/ci/check-config.js) will block the PR. |
| Adding a new route without an auth middleware | Don't. Mount `authenticate` / `adminAuth` / `optionalAuthenticate`, or annotate `// ci:routes-exempt` with a reason. The CI guard [`check-routes`](../../scripts/ci/check-routes.js) will block the PR. |
| Creating a Mongoose model that ignores the plugin set | Don't. Apply at least one plugin from [`src/models/plugins/`](../../src/models/plugins/). The CI guard [`check-models`](../../scripts/ci/check-models.js) will block the PR. |
| Importing `ioredis`, `bullmq`, `@aws-sdk/client-s3` or `nodemailer` from feature code | Don't. Go through the [service wrappers](./backend/README.md). |
| Pushing a sprint without updating `STATUS.md` | The PR template requires it. CI guard [`check-readme-sync`](../../scripts/ci/check-readme-sync.js) reminds you. |

---

## Related Documents

- [`README.md`](./README.md) — documentation homepage
- [`STATUS.md`](./STATUS.md) — project state
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture
- [`DECISIONS.md`](./DECISIONS.md) — architectural decisions
- [`02-project-vision.md`](./02-project-vision.md) — why we exist
- [`03-product-roadmap.md`](./03-product-roadmap.md) — phase-by-phase plan
- [`phases/README.md`](./phases/README.md) — sprint index
- [Repo-root `README.md`](../../README.md) — public home page
- [Repo-root `CHANGELOG.md`](../../CHANGELOG.md) — chronological log

---

## Summary

`01-getting-started.md` is the day-one onboarding document. It tells
a new engineer what the project is, *why* it exists, who should read
this doc, how to ramp up in five stages, the recommended reading
order, prerequisites, a copy-pasteable quick start, an optional full
local stack via Docker, a day-one checklist, where to get help, and
the common mistakes the CI guards already prevent.

## Key Takeaways

- You only need Node 20+ to be productive. MongoDB and Redis are
  optional in development because the server boots in *degraded mode*.
- The recommended reading order is tiered: 1 hour for Tier 1, 1 hour
  for Tier 2, then as-needed for Tier 3.
- Every common first-day mistake the codebase already has a CI guard
  for — read the *Common First-Day Mistakes* table before opening your
  first PR.

## Interview Preparation

### Common Questions

- "Walk me through how you onboard a new engineer to a large codebase."
- "What does a 'healthy' backend repo look like on day one?"
- "Why is degraded mode useful, and where can it bite you?"

### Sample Answers

- **"Walk me through how you onboard a new engineer."** — Stage 1 is
  operational: clone, install, run, hit `/health`, run tests, run CI
  guards. Stage 2 is structural: folder layout + architecture diagram
  + status table. Stage 3 is conventions: architecture rules, ADRs,
  guard scripts. Stage 4 is contributing: open a starter issue,
  draft a PR early. Stage 5 is ownership: review a colleague's PR
  confidently. We expect ≈ 1 day to reach Stage 4.

- **"What does a 'healthy' backend repo look like on day one?"** —
  Centralised config that never touches `process.env`, a single error
  envelope, a dependency-free validator engine, a fail-closed default
  for security middleware, an explicit CI guard for every
  architectural rule, and `npm test` plus `npm run ci:guards` green
  on a fresh checkout with no MongoDB or Redis running.

- **"Why is degraded mode useful, and where can it bite you?"** —
  Useful because it lets every engineer run the app locally without
  installing MongoDB and Redis. It bites when you forget that some
  routes depend on DB state and your local checks pass while prod
  fails. The mitigation is integration tests against
  `mongodb-memory-server` and a CI run that exercises the health
  probe (which reports `db: 'disconnected'` explicitly).

### Real-World Examples

- A new joiner clones the repo on Monday morning. By lunch they have
  the dev server running, the test suite green, and a starter issue
  scoped. By Friday they have shipped their first PR.
- An interviewer asks "how do you keep new engineers productive?" The
  answer points at this document and the five-stage ramp.

### Common Mistakes

- Skipping Stage 1 and trying to read architecture docs on an empty
  laptop.
- Reading every document linearly. Use the tiered order; jump to Tier 3
  only when you have a specific question.
- Treating the *Common First-Day Mistakes* table as folklore. Every
  row maps to a real CI guard; run `npm run ci:guards` to see it fire.

## Related Documents

- [`README.md`](./README.md) — documentation homepage
- [`STATUS.md`](./STATUS.md) — daily-read project state
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture
- [`DECISIONS.md`](./DECISIONS.md) — architectural decisions
- [`02-project-vision.md`](./02-project-vision.md) — why we exist

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)