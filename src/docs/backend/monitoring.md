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

## Phase 3 Probes (deferred)

- `/monitoring/queue` — BullMQ queue depth per name.
- `/monitoring/scheduler` — registered cron jobs and last-run status.
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