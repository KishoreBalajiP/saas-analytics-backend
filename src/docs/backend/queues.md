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

## Failure Modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Job stuck | Worker crashed | BullMQ retries; check `/monitoring/queue` (Phase 3) |
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