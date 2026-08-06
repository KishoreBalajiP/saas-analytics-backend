# Phase 1 — Production Backend Foundation

> **WHAT this is:** the record of Phase 1, the foundational architecture
> the entire platform sits on.
> **WHY it exists:** every later phase assumes Phase 1; documenting it
> once is cheaper than re-explaining it forever.
> **HOW to use it:** read the *Deliverables* and *Completion Criterion*
> sections to verify Phase 1 is done.
> **WHEN to update it:** only if a Phase 1 file changes — Phase 1 is
> closed.
> **WHERE it lives:** `src/docs/phases/phase-1.md`.

---

## Purpose

> **WHAT this is:** the record of Phase 1 — the foundational
> architecture the entire platform sits on.
> **WHY it exists:** every later phase assumes Phase 1; documenting it
> once is cheaper than re-explaining it forever.
> **HOW to use it:** read the *Deliverables* and *Completion Criterion*
> sections to verify Phase 1 is done.
> **WHEN to update it:** only if a Phase 1 file changes (rare).
> **WHERE it lives:** `src/docs/phases/phase-1.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **New backend engineer** | Knows what Phase 1 shipped before reading any code. |
| **Tech lead** | Can verify Phase 1 deliverables against the live repo. |
| **Interview candidate** | Has a single document describing the foundation. |

## Current Status

> **Status:** `Completed`.
> **Sprint:** Phase 1 was completed before the Sprint 0 numbering
> began; it is the foundation on which Sprint 0 sits.
> **Owner:** Founding architect.

## Business Perspective

Phase 1 exists so the platform can be developed in the open, in
parallel, without a single architectural decision being made twice.
Every later feature assumes the configuration layer, the error
envelope, the request-id, the rate-limiter and the validator engine
exist and behave in documented ways.

## Technical Perspective

Phase 1 ships every cross-cutting infrastructure layer *except* the
business logic. It is the skeleton the platform will live inside.

## Architecture

```
src/
├── app.js                  # Express assembly (middleware order)
├── server.js               # Process bootstrap (HTTP, Socket.IO, DB, scheduler)
├── config/                 # env, constants, cors, database, logger, mail, scheduler, socket
├── routes/                 # route mounting (health + future feature shells)
├── connectors/             # connector framework: BaseConnector + registry
├── queues/                 # async queue contracts (no transport installed yet)
├── storage/                # storage abstraction (local / s3, provider stubs)
├── cache/                  # cache abstraction (memory / redis, provider stubs)
├── controllers/            # HTTP layer (README with conventions)
├── services/               # business logic layer (README with conventions)
├── repositories/           # data-access layer (README with conventions)
├── models/                 # Mongoose models (none yet - README with conventions)
├── validators/             # request validation engine (dependency-free)
├── middleware/             # express middleware
├── websocket/              # Socket.IO bootstrap + events + rooms
├── jobs/                   # scheduler + background job stubs
├── utils/                  # cross-cutting helpers (ApiError, encryption, ...)
├── templates/emails/       # future email templates
├── modules/                # feature modules (iam/, platform/, governance/, ...)
└── docs/                   # architecture documentation
```

## Deliverables

| Area | Files | Purpose |
| --- | --- | --- |
| Process bootstrap | `src/app.js`, `src/server.js` | Express assembly + HTTP/Socket.IO/DB/scheduler lifecycle |
| Configuration | `src/config/env.js`, `src/config/constants.js`, `src/config/cors.js`, `src/config/database.js`, `src/config/logger.js`, `src/config/mail.js`, `src/config/scheduler.js`, `src/config/socket.js` | Every env var flows through here; no module reads `process.env` directly |
| Error envelope | `src/utils/ApiError.js`, `src/utils/ApiResponse.js`, `src/middleware/error.middleware.js`, `src/middleware/notFound.middleware.js` | One shape, every failure |
| Request identity | `src/middleware/requestId.middleware.js` | `req.id` + `req.log` |
| Rate limit | `src/middleware/rateLimiter.middleware.js` | `apiLimiter`, `createRateLimiter`, `strictLimiter` |
| Validation | `src/validators/index.js` | Dependency-free schema engine |
| WebSocket | `src/websocket/index.js`, `src/websocket/events.js`, `src/websocket/rooms.js` | Socket.IO bootstrap + room helpers |
| Scheduler | `src/jobs/scheduler.js` | node-cron orchestrator |
| Connector framework | `src/connectors/BaseConnector.js`, `src/connectors/ConnectorRegistry.js`, `src/connectors/index.js` | `connect`, `validate`, `preview`, `ingest`, `disconnect` lifecycle |
| Infrastructure facades | `src/cache/index.js`, `src/storage/index.js`, `src/queues/index.js` | Stable contracts with fail-closed stubs |
| Cross-cutting helpers | `src/utils/asyncHandler.js`, `src/utils/crypto.js`, `src/utils/date.js`, `src/utils/helpers.js`, `src/utils/logger.js`, `src/utils/stubs.js`, `src/utils/encryption.js` | Shared building blocks |

## Dependencies

None — Phase 1 is the foundation.

## Completion Criterion

```bash
npm install
npm run dev              # binds port 8080, prints the startup line
curl http://localhost:8080/api/v1/health    # → 200 with the envelope
npm test                 # → 2 / 2 pass (smoke suite)
```

All four commands pass on a fresh checkout with no MongoDB or Redis
running.

## Expected Outcome

A repository that a new engineer can clone, install, run and explore
without any business feature being live, and without any architectural
discipline being violated. Every later sprint writes code into a
folder Phase 1 created.

## Real-world Examples

- A new engineer runs the four commands above in their first hour.
- An interviewer asks "what does the skeleton look like?" They open
  this file, then jump to [`ARCHITECTURE.md`](../ARCHITECTURE.md).

## Best Practices

| Do | Why |
| --- | --- |
| **Read Phase 1 before reading any other phase.** | Every other phase assumes Phase 1 is in place. |
| **Treat the rule "modules never read `process.env`" as load-bearing.** | The CI guard `check-config` enforces it; the rule exists because config-driven deploys are the platform's portability promise. |
| **Treat the rule "every unimplemented middleware returns 501" as load-bearing.** | The CI guard `check-routes` enforces it; the rule exists because silent allow-through is a security hole. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Adding a business model in Phase 1.** | Phase 1 is architecture only. The first real model lands in Sprint 1. |
| **Reading `process.env` from feature code.** | Goes through `src/config/env.js` or the PR will be blocked. |
| **Returning a non-envelope error.** | The `errorHandler` is the single source of truth; bypass it and you break every client SDK. |

---

## Summary

Phase 1 ships every cross-cutting infrastructure layer the platform
sits on: process bootstrap, configuration, error envelope, request
identity, rate limit, validation, WebSocket bootstrap, scheduler,
connector framework and infrastructure facades. Every Phase 1 file is
still in the repository; every later sprint writes code into folders
Phase 1 created.

## Key Takeaways

- **Phase 1 is the skeleton, not the body.** No business logic ships
  in this phase.
- **Two rules are load-bearing:** no module reads `process.env`;
  every unimplemented security middleware returns `501`. Both are
  CI-enforced.
- **The four-command smoke test** (`npm install` → `npm run dev` →
  `curl /health` → `npm test`) is the Definition of Done for any
  later phase that touches the foundation.

## Interview Preparation

### Common Questions

- "What is the foundation of your backend?"
- "How do you enforce that contributors do not break the
  architecture?"
- "Why is the configuration layer centralised?"

### Sample Answers

- **"What is the foundation?"** — A single boot path (`server.js`)
  that wires HTTP, Socket.IO, MongoDB and the scheduler; a single
  Express assembly (`app.js`) with the documented middleware order;
  a single error envelope (`ApiError` + `errorHandler`); a single
  configuration loader (`config/env.js`) that no other file may
  bypass; a single request-id; a single rate-limiter; a
  dependency-free validator engine; a Socket.IO bootstrap with
  room helpers; a node-cron scheduler with job stubs; a connector
  framework; and stable contracts for cache, storage and queues.

- **"How do you enforce the architecture?"** — Five CI guardrails
  (`scripts/ci/`). `check-stubs` fails an orphan `notImplementedStub`;
  `check-routes` fails a real route without auth; `check-models`
  fails a Mongoose model without a plugin; `check-config` fails a
  `process.env` read outside `src/config/`; `check-readme-sync`
  fails missing root docs and per-module `STATUS.md`.

- **"Why centralise config?"** — Three reasons. (1) Portability: the
  same code runs on Render, Railway, Docker and AWS ECS because
  every environment difference is a config variable. (2) Audit:
  every env var is documented in `.env.example` and validated in
  `env.js`. (3) Testability: tests can swap the frozen config
  object without touching source files.

### Real-World Examples

- A new engineer opens this file, then opens
  [`ARCHITECTURE.md`](../ARCHITECTURE.md), and has a complete
  picture of the foundation in under 30 minutes.
- A reviewer runs `npm run ci:guards` on a Phase 2 PR; `check-config`
  blocks a `process.env` read, the contributor routes it through
  `env.js`, the PR merges.

### Common Mistakes

- Treating Phase 1 as "done and forget about it". The CI guards that
  enforce it must keep running.
- Reading `process.env` because "it is just one variable". The rule
  is about consistency, not about this one variable.
- Returning a stack trace to a client. The `errorHandler` strips
  stacks in production; bypassing it leaks internals.

## Related Documents

- [`../README.md`](../README.md) — documentation homepage
- [`../STATUS.md`](../STATUS.md) — daily-read project state
- [`../TEMPLATE.md`](../TEMPLATE.md) — documentation standard
- [`../01-getting-started.md`](../01-getting-started.md) — onboarding
- [`../03-product-roadmap.md`](../03-product-roadmap.md) — phase-by-phase plan
- [`phase-1.1.md`](./phase-1.1.md) — next phase
- [`phase-1.2.md`](./phase-1.2.md) — final architecture phase
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — system architecture
- [`../DECISIONS.md`](../DECISIONS.md) — architectural decisions
- [Repo-root `README.md`](../../../README.md) — public home page
- [Repo-root `CHANGELOG.md`](../../../CHANGELOG.md) — chronological log

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 1 — Production Backend Foundation (completed before Sprint 0)
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)