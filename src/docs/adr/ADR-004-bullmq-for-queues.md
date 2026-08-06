# ADR-004: Use BullMQ for Durable Queue Transport

**Status:** Accepted
**Date:** 2026-08-05

## Context

Connector syncs, email delivery and analytics jobs need to survive
process restarts, run concurrently with retries and backoff, and
scale horizontally across workers.

## Decision

Use BullMQ on Redis when `REDIS_URL` is set; an in-memory transport
with the same handle surface is used otherwise.

## Consequences

**Easier:**

- Same queue contract everywhere; feature code never imports
  `bullmq`.
- Tests run without Redis.
- Production needs `REDIS_URL` set for durability.
- `@aws-sdk/lib-storage` is used for S3 multipart uploads; BullMQ
  Workers use a separate Redis connection.

**Harder:**

- Two transports to maintain.
- BullMQ has a learning curve; addressed in `services/queue.service.js`.

## Implementation

- `src/queues/memory.queue.js` — in-memory transport.
- `src/queues/index.js` — BullMQ transport selector.
- `src/queues/{connector,email,analytics}.queue.js` — per-queue
  contracts.
- `src/services/queue.service.js` — public interface with typed
  helpers (`enqueueConnectorSync`, `enqueueEmail`, `enqueueAnalytics`).

## Related

- [`../backend/queues.md`](../backend/queues.md)