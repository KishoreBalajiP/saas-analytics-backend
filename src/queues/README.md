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

## Transport strategy

- **Development / tests:** in-memory transport (`memory.queue.js`, single
  process; messages do not survive a restart).
- **Production:** BullMQ on Redis when `REDIS_URL` is set. Producers use a
  fail-fast Redis connection separate from the worker's and every enqueue is
  bounded by `QUEUE_PRODUCER_TIMEOUT_MS` (typed `QueueError`, HTTP 503).
- Deployment-independent: the transport is chosen by env/config only, never
  hard-coded.
- Consumers run only in processes whose `PROCESS_ROLE` is `worker` or `all`
  (`src/jobs/background.js`); `closeAll({ drainTimeoutMs })` drains them on
  shutdown.

## Integration points (already prepared)

- `src/jobs/scheduler.js` - cron workers will *produce* queue messages.
- `src/jobs/email.job.js` - future poller for the email queue.
- `src/modules/connectors/*` - sync entry points enqueue, not ingest inline.
- `src/storage/` - queue workers write exports through the storage abstraction.
- `src/websocket/` - job progress/results are pushed over Socket.IO rooms.

## Status

Implemented: connector sync, analytics (report/alert) and export consumers;
email delivery remains a fail-closed contract. Durable-job behaviour (roles,
leases, sync runs, reaper, drain) is described in
`src/docs/backend/queues.md`.
