# Queues - architecture

Asynchronous processing layer. **Architecture only - no transport installed,
no queues running in Phase 1.1.**

## Why queues

- Connector syncs (CSV, Google Sheets, customer MongoDB, webhooks) can be
  large and slow - they must never run inside an HTTP request.
- Email delivery and analytics exports should retry independently of the
  request that created them.
- Queued work survives process restarts and lets the platform scale
  horizontally (multiple workers) without code changes.

## The contract

Every queue exposes the same handle surface (defined in `src/queues/index.js`):

| Method      | Future responsibility                              |
| ----------- | -------------------------------------------------- |
| `enqueue()` | push a message onto the queue                      |
| `schedule()`| push a delayed/one-off message                    |
| `consume()` | register a worker that processes messages         |
| `on()`      | subscribe to lifecycle events (failed, stalled)   |
| `close()`   | flush + release resources on shutdown             |

Messages are plain objects with an `idempotencyKey` so retries never apply an
operation twice. Message shapes are documented in each queue module.

## Queues

| Queue | Name             | Purpose                                        |
| ----- | ---------------- | ---------------------------------------------- |
| `connector.queue.js` | `connector.sync`     | connector preview/ingest/sync jobs    |
| `email.queue.js`     | `email.delivery`     | transactional + alert email          |
| `analytics.queue.js` | `analytics.jobs`     | aggregations, exports, recomputes    |

## Transport strategy (future, not installed)

- **Development / tests:** in-memory Map-based transport (no dependency).
- **Production:** BullMQ on Redis (single-dependency, battle-tested), with
  Bull Board for observability. `REDIS_URL` is already reserved in `.env.example`
  and `config/env.js` (`config.redis`).
- Deployment-independent: the transport is chosen by env/config only, never
  hard-coded.

## Integration points (already prepared)

- `src/jobs/scheduler.js` - cron workers will *produce* queue messages.
- `src/jobs/email.job.js` - future poller for the email queue.
- `src/modules/connectors/*` - sync entry points enqueue, not ingest inline.
- `src/storage/` - queue workers write exports through the storage abstraction.
- `src/websocket/` - job progress/results are pushed over Socket.IO rooms.

## Status

Phase 1.1 defines the contract and names only. Nothing is installed (`no
Redis`, `no BullMQ`) and no consumer is registered.
