# Backend — Queue System

> **WHAT this is:** the deep-dive on the queue layer (BullMQ + in-memory).
> **WHY it exists:** every long-running job is a queue message.
> Provider-agnostic so we can run in dev without Redis.
> **HOW to use it:** read *Architecture* before publishing a message;
> re-read *Best Practices* before consuming.
> **WHEN to update it:** as the queue layer evolves.
> **WHERE it lives:** `src/docs/backend/queues.md`.

---

## Purpose

> **WHAT this is:** the deep-dive on the queue layer.
> **WHY it exists:** every long-running job is a queue message.
> **HOW to use it:** read *Architecture* before publishing; re-read
> *Best Practices* before consuming.
> **WHEN to update it:** as the queue layer evolves.
> **WHERE it lives:** `src/docs/backend/queues.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 6 / 9 implementer** | Has the consumer contract. |
| **Operator** | Has the queue depth + retry behaviour. |

## Current Status

> **Status:** `Implemented (Sprint 0)` — driver in place; consumers
> register in Sprints 1, 6, 7, 9.
> **Sprint:** Sprint 0 (driver); Sprints 1, 6, 7, 9 (consumers).
> **Owner:** Engineering team.

## Business Perspective

Connector syncs, email delivery, analytics jobs and governance
retention all run asynchronously. The HTTP request returns
immediately; the worker continues.

## Technical Perspective

In-memory transport for dev/tests; BullMQ on Redis for production.
Same handle surface: `enqueue`, `schedule`, `consume`, `on`,
`close`. Selected by env (`REDIS_URL`).

## Architecture

```
                ┌──────────────────────┐
                │  Feature code         │
                │  (controllers / jobs) │
                └──────────┬───────────┘
                           │ services/queue.service.js
                           ▼
                ┌──────────────────────┐
                │  Queue facade         │
                │  createQueue(name)    │
                └──────────┬───────────┘
                           │
            ┌──────────────┴──────────────┐
            │                             │
            ▼                             ▼
   ┌────────────────────┐       ┌────────────────────┐
   │  In-memory transport│       │  BullMQ on Redis   │
   │  (dev / tests)      │       │  (production)       │
   └─────────┬──────────┘       └──────────┬──────────┘
             │                              │
             ▼                              ▼
   ┌────────────────────┐       ┌────────────────────┐
   │  Worker (same proc) │       │  Worker (same or    │
   │                     │       │  separate proc)     │
   └────────────────────┘       └────────────────────┘
```

## Queue Names

| Queue | Use | Owning Sprint |
| --- | --- | --- |
| `connector.sync` | connector preview / ingest / sync | Sprint 6 |
| `email.delivery` | outbound email | Sprint 1 |
| `analytics.jobs` | aggregations, exports, recomputes | Sprint 9 |

## Real-world Examples

### Enqueue

```js
import { enqueueConnectorSync } from '../services/queue.service.js';

await enqueueConnectorSync({
  connectorId: 'con_01H...',
  tenantId: 't_01H...',
  jobType: 'ingest',
  payload: { since: '2026-08-01' },
  idempotencyKey: 'con_01H:ingest:2026-08-05',
});
```

### Consume (Sprint 6 connector worker)

```js
import { registerConsumer } from '../services/queue.service.js';

registerConsumer('connector.sync', async ({ data }) => {
  const { connectorId, tenantId, jobType, payload } = data;
  const connector = await loadConnector(connectorId);
  await connector[jobType](payload);
});
```

## Best Practices

| Do | Why |
| --- | --- |
| **Idempotency key on every message.** | Retries never duplicate work. |
| **Use `schedule()` for delayed jobs** (e.g. retry with backoff). | The transport handles the delay. |
| **Subscribe via `services/queue.service.js`, not BullMQ directly.** | The CI guard enforces it. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Blocking the HTTP request on a queue job.** | The whole point of the queue is to return fast. |
| **Importing `bullmq` from feature code.** | Provider switching becomes a refactor. |
| **Skipping the idempotency key.** | Retries double-charge, double-ingest. |

## Durable jobs (roadmap 1.4)

- **Process roles.** `PROCESS_ROLE=web` serves HTTP and only enqueues;
  `npm run start:worker` (`src/worker.js`) runs every consumer and the
  scheduler; `all` (default) does both. `web` requires `REDIS_URL`.
- **Producers fail fast.** Every enqueue is bounded by
  `QUEUE_PRODUCER_TIMEOUT_MS` and fails with a typed `QueueError`
  (`QUEUE_TIMEOUT` / `QUEUE_UNAVAILABLE`, HTTP 503). BullMQ producers use a
  fail-fast Redis connection separate from the worker's. `GET
  /api/v1/health/ready` answers 503 when that connection does not return a
  PING within 1 s (`data.queue`: `memory` | `ok`).
- **Distributed cron.** Each tick takes a lease lock per job
  (`src/jobs/lock.js`: Redis `SET NX PX`, or a `JobLock` document) and
  writes a `JobRun`. Due reports/alerts are claimed with one atomic update
  that advances `nextRunAt`/`nextEvaluationAt` and sets
  `lockedBy`/`lockedUntil`, so two instances run each item once per tick.
- **Sync runs and leases.** Every connector sync is a `SyncRun`; a queued
  or running sync holds `syncLeaseUntil` (renewed by the worker). The
  `stale-job-recovery` job resets connectors whose lease expired, marks
  their run `abandoned`, re-queues pull syncs once, and closes stale
  `JobRun`s. A webhook delivery carries its records in the message, so when
  BullMQ redelivers one whose run was abandoned, the worker replays it under
  a fresh run (rows stored, storedRows reservation settled). A tenant lookup
  that fails on a message's last attempt closes its run `failed`, frees the
  slot and gives the reservation back before the error is rethrown.
- **Webhook storedRows reservations.** A delivery's request-time
  reservation is a `UsageReservation` ledger entry keyed by its job id
  (every delivery gets a unique job id). The worker draws the rows it really
  adds from the entry; rows a failed attempt did not store go back to it, so
  a retry or replay draws exactly what is still unstored. The entry is
  settled (unused part given back) once the message is done. Usage
  reconciliation counts open entries as in use, and voids entries older than
  `USAGE_RESERVATION_TTL_HOURS` (message presumed lost) before correcting.
- **Tenant status.** Scheduled reports, alert evaluations and syncs re-check
  that the tenant is `active` when they execute.
- **Graceful drain.** SIGTERM closes Socket.IO with the HTTP server, stops
  the scheduler, lets in-flight jobs finish within
  `SHUTDOWN_DRAIN_TIMEOUT_MS` (the in-memory transport refuses new enqueues
  with a 503 once its drain starts, since they could not survive the exit;
  BullMQ keeps accepting them into Redis), then closes queues, Redis, the
  storage driver and MongoDB (`src/jobs/shutdown.js`).

## Failure Modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Job stuck | Worker crashed | BullMQ redelivers stalled jobs; the stale-job reaper recovers connectors past their lease; check `/monitoring/health/queue` and `/monitoring/jobs/runs` |
| Sync API returns 503 `QUEUE_TIMEOUT` | Redis unreachable | Restore Redis; the request can be retried, nothing is left queued |
| Sync API returns 409 `SYNC_IN_PROGRESS` | A live sync holds the connector | Wait for it, or for its lease to expire if the worker died |
| Job fails repeatedly | Bad config / data | After `attempts` (default 5), the job is parked; inspect failed jobs |
| Queue depth grows | Consumer too slow | Scale workers; check `concurrency` per queue |

---

## Summary

The queue layer has two transports (in-memory + BullMQ) and one
public service (`services/queue.service.js`). Feature code never
imports `bullmq`. Idempotency keys are mandatory.

## Key Takeaways

- **Provider-agnostic.** In-memory in dev, BullMQ in prod.
- **Idempotency key on every message.**
- **Subscribe via `services/queue.service.js`.**

## Interview Preparation

### Common Questions

- "Why a queue abstraction?"
- "How do you handle retries?"

### Sample Answers

- **"Why an abstraction?"** — Provider switching is a one-file
  change; feature code never imports BullMQ.
- **"Retries?"** — BullMQ's exponential backoff; after `attempts`
  the job is parked for inspection.

## Related Documents

- [`../phases/sprint-6.md`](../phases/sprint-6.md) — first consumer
- [`../phases/sprint-1.md`](../phases/sprint-1.md) — email consumer
- [`../../services/queue.service.js`](../../../src/services/queue.service.js) — facade
- [`../DECISIONS.md`](../DECISIONS.md) — ADR-004

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)