# Runbook: Redis down

**Alerts:** `AnalivoDependencyDown{dependency="redis"}`, `AnalivoQueueUnreachable`, `AnalivoNotReady`.
**Impact:** Redis carries the job queues (BullMQ), the shared cache, rate-limit counters, webhook replay protection, idempotency outcomes and Socket.IO fan-out. With Redis down, instances report `not_ready` (503), enqueueing work fails fast with `503 QUEUE_UNAVAILABLE`, and queued work waits.

The platform does **not** fall back to in-memory drivers at runtime. The driver is chosen once at boot from `REDIS_URL`, and an in-memory queue on a web instance would silently lose jobs. Fix Redis instead.

## Confirm

1. `/api/v1/health/ready` returns 503 with `"redis":"down"` and/or `"queue":"down"`.
2. The admin Monitoring page still loads: the aggregate is computed without its cache and shows `redis.status: down` with a short error.
3. Logs: `Redis cache connection error`, `queue producer Redis error`, `queue worker Redis error`.
4. Check the Redis provider: memory usage (eviction policy must be `noeviction` for BullMQ), connection count, maxclients.

## Act

1. If memory is full, check which keys grow: `bull:*` (queue backlog, see [queue-backlog.md](queue-backlog.md)), `cache:*`, `rl:*`. Raise memory or clear the analytics cache keys (`cache:analytics:*`). Never flush `bull:*`: it deletes queued jobs.
2. If the provider rotated credentials or the URL changed, update `REDIS_URL` on the web and worker services and redeploy both.
3. If the network path is broken (TLS, allow-list), fix it. Instances reconnect by themselves (ioredis retries).

## Verify recovery

- `/api/v1/health/ready` returns 200 everywhere; `analivo_queue_up` is 1 for every queue.
- `analivo_queue_jobs{state="waiting"}` drains (the worker picks up what accumulated).
- Connector syncs and report runs requested during the outage were refused with 503; tell affected tenants to retry, or re-run them from the admin tools.

## Escalate

Provider-side outage longer than 15 minutes: page the engineering lead and post on the status channel (`/api/v1/status` will show `outage` for `api`).
