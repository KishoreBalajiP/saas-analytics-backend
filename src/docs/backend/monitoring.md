# Backend — Monitoring

> **WHAT this is:** the deep-dive on health probes and observability
> seams.
> **WHY it exists:** operators must know what is broken and where.
> **HOW to use it:** read *Architecture*; check `/health` after every
> deploy.
> **WHEN to update it:** as probes evolve.
> **WHERE it lives:** `src/docs/backend/monitoring.md`.

---

## Purpose

> **WHAT this is:** the deep-dive on monitoring.
> **WHY it exists:** operators must know what is broken.
> **HOW to use it:** read *Architecture*; check `/health` after every
> deploy.
> **WHEN to update it:** as probes evolve.
> **WHERE it lives:** `src/docs/backend/monitoring.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Operator / on-call** | Has the dashboard. |
| **Sprint 8 implementer** | Has the probe contract. |

## Current Status

> **Status:** `Implemented (MVP)` — `/health` works; full
> `/monitoring/*` ships in Sprint 8.
> **Sprint:** Sprint 8.
> **Owner:** Engineering team.

## Business Perspective

The platform must be operable in production. Operators need to know
which subsystem is broken (DB, queue, storage, scheduler) without
reading logs. The monitoring surface answers that.

## Technical Perspective

Each probe has a 2-second timeout. `/monitoring/aggregate` is cached
5 seconds. Sprint 8 ships the MVP probes; Phase 3 ships the
deeper probes (queue depth, scheduler state, connector health,
Prometheus `/metrics`).

## Architecture

```
                ┌──────────────────────────────┐
                │  /monitoring/system            │  process uptime, memory, CPU
                │  /monitoring/db                │  MongoDB ping
                │  /monitoring/websocket         │  Socket.IO room count
                │  /monitoring/queue             │  queue depth (Phase 3)
                │  /monitoring/scheduler          │  registered cron jobs (Phase 3)
                │  /monitoring/storage           │  S3 ping (Phase 3)
                │  /monitoring/connectors        │  registered connectors (Phase 3)
                │  /monitoring/aggregate          │  5 s cached rollup
                │  /monitoring/metrics            │  Prometheus (Phase 3)
                └──────────────────────────────┘
                              ▲
                              │ admin-gated
                              ▼
                ┌──────────────────────────────┐
                │  /support/impersonate          │
                │  /support/account-recover      │
                │  /support/broadcast (Phase 3)   │
                │  /support/cross-tenant-lookup  │
                └──────────────────────────────┘
```

## MVP Probes (Sprint 8)

### `/health` (Sprint 1)

- Public.
- Returns `{ status: 'ok', db: 'connected' | 'disconnected' }`.
- Rate-limit-exempt.

### `/monitoring/system`

- Process uptime, memory, CPU.
- 2 s timeout.

### `/monitoring/db`

- `mongoose.connection.readyState === 1` plus a `ping`.
- 2 s timeout.

### `/monitoring/websocket`

- `getIO()` is initialised.
- `clients.size` reported.

### `/monitoring/aggregate`

- 5 s cached rollup of every MVP probe.

## Job probes (roadmap 1.4, live)

- `/monitoring/health/scheduler` — registered cron jobs with last run, last
  success, last failure and an `overdue` flag (from `JobRun` records, so a
  web instance reports the worker's scheduler).
- `/monitoring/health/queue` — per-queue counts (BullMQ `getJobCounts` or
  the in-memory transport) and whether this process consumes.
- `/monitoring/jobs/runs` — paginated `JobRun` history (filters `job`,
  `status`).
- `/api/v1/health/ready` (public) — see below.

## Mail, outbox and retention (roadmap 2.7, live)
## Observability (roadmap 2.8, live)

- `/monitoring/health/mail` — transport (`smtp`/`noop`), a bounded SMTP
  verify (cached 60 s), outbox counts per status, backlog age and the last
  send outcome. `disabled` = no transport (mail is not delivered), `down` =
  verify failed or 3+ consecutive send failures, `degraded` = dead letters
  or a due message older than 15 minutes. Also reported (not rolled up) in
  `/health/aggregate` as `mail`.
- `/monitoring/outbox` — paged `OutboundEmail` records (filters `status`,
  `tenantId`); recipients masked, template variables never returned. A
  tenant-scoped admin only sees its tenant.
- `POST /monitoring/outbox/:id/requeue` — `monitoring.update`; returns a
  dead letter to the queue with a fresh attempt budget (audited).
- `/monitoring/retention` — every retention policy (collection, env key,
  window, cutoff, how it is enforced), the tenants under legal hold and the
  cleanup job's latest run (its `counts` are the per-collection report).
- **Readiness** `GET /api/v1/health/ready` (public, `services/readiness.service.js`):
  critical checks (database, Redis when configured, queue transport) run on
  every call within `READINESS_CHECK_TIMEOUT_MS`; any `down` -> 503
  `not_ready`. Non-critical checks (storage, scheduler heartbeat from
  JobRun records, SMTP verify) are cached (`READINESS_CACHE_TTL_MS`,
  `READINESS_SMTP_TTL_MS`) and make the instance `degraded` (200). The body
  lists component statuses only. Transitions are logged once.
- **Status** `GET /api/v1/status` (public, cached `STATUS_CACHE_TTL_MS`):
  `operational | degraded | outage` overall and for `api`,
  `background_jobs`, `file_storage`, `email_delivery`. No internals.
- **Probes** `/monitoring/health/redis`, `/storage` (provider round trip;
  S3 403 = degraded), `/smtp` (verify; `disabled` when mail is off),
  `/connectors` (platform-wide counts by status). The aggregate rolls
  them up (database/Redis/queue down -> `down`, anything else ->
  `degraded`) and is computed uncached when the cache itself fails, so
  the page shows `redis: down` instead of a 500.
- **Metrics** `GET /api/v1/metrics` (Prometheus text, bearer
  `METRICS_TOKEN`, 404 when unset; `utils/metrics.js`, no dependency):
  HTTP requests and latency by route template, API errors by code, auth
  failures, quota rejections, analytics query latency/outcomes, job runs,
  queue jobs and depth, email sends, outbox backlog, dependency status,
  error reports, process stats. `/monitoring/metrics` returns the same
  registry as JSON for the admin page.
- **Tracing**: `X-Request-Id` (validated) and W3C `traceparent` are carried
  in AsyncLocalStorage, added to every log line, copied into queue jobs
  (`data._trace`) and continued by consumers and scheduled ticks.
- **Error reporting** `services/errorReporter.service.js`: API 5xx, failed
  scheduled jobs, queue jobs out of attempts, process crashes and frontend
  reports (`POST /api/v1/client-errors`, public, rate-limited) go to the
  configured sink (`ERROR_REPORTER=none|log|http`), scrubbed of secrets and
  PII, deduplicated and rate-capped.
- **Runbooks and alert rules**: `src/docs/development/runbooks/`.

## Phase 3 Probes (deferred)

- `/monitoring/storage` — S3 ping.
- `/monitoring/connectors` — registered connectors.
- `/monitoring/metrics` — Prometheus exposition.

## Best Practices

| Do | Why |
| --- | --- |
| **Time-box every probe** to 2 s. | A probe that hangs blocks the dashboard. |
| **Cache the aggregate** for 5 s. | The dashboard refresh is interactive; the underlying probes can be slow. |
| **Audit every admin-gated probe hit.** | Operators are accountable. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Probing the DB on every health check at high frequency.** | The DB is the probe; probing it hammers it. Cache. |

---

## Summary

The monitoring surface ships in Sprint 8. MVP probes cover
process, DB and WebSocket. Phase 3 adds queue, scheduler, storage,
connector and Prometheus.

## Key Takeaways

- **Time-box probes.**
- **Cache the aggregate.**
- **Audit operator hits.**

## Related Documents

- [`../phases/sprint-8.md`](../phases/sprint-8.md) — sprint plan
- [`../../services/`](../../../src/services/) — service wrappers
- [`../03-product-roadmap.md`](../03-product-roadmap.md) — Phase 3 plans

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)