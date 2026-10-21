# Runbook: queue backlog or stalled jobs

**Alerts:** `AnalivoQueueBacklog`, `AnalivoJobNotSucceeding`, readiness `degraded` with `"scheduler":"degraded"`.
**Impact:** connector syncs, report generation, alert evaluation, exports or email delivery are late. Data is not lost while jobs stay queued.

## Confirm

1. Admin Monitoring, or `GET /monitoring/health/queue`: `waiting`, `active`, `delayed` and `failed` per queue, and whether this instance consumes (`consumersInProcess`).
2. `GET /monitoring/health/scheduler`: an `overdue: true` job, or a `lastRun.status` of `failed` or `abandoned`.
3. `GET /monitoring/jobs/runs?status=failed`: recent failed runs with a sanitised error.
4. Metrics: `analivo_queue_jobs{state="waiting"}` growing, `analivo_queue_jobs_processed_total{outcome="failed"}` rising, `analivo_job_runs_total{status="failed"}`.

## Act

1. **Is a worker running?** In production the web service runs with `PROCESS_ROLE=web` and only enqueues. The worker service (`npm run start:worker`) must be up. If it is crash-looping, read its logs first (often the database or Redis, see the other runbooks).
2. **Is one job type failing in a loop?** Find the error in the error tracker (`source: queue` or `source: job`) and in the logs by `queue` and `jobId`. Follow `traceId` back to the HTTP request that enqueued it.
3. **Throughput, not failure?** Scale the worker service horizontally (each instance consumes; scheduler ticks are protected by locks), or raise `CONNECTOR_QUEUE_CONCURRENCY` carefully: it multiplies database load.
4. **Stuck syncs** (connector shows `running` for a long time): the stale-job reaper resets them after `CONNECTOR_SYNC_LEASE_MS`. Check that `JOB_STALE_RECOVERY_ENABLED=true`.
5. **One tenant flooding the queue:** identify it from job logs (`tenantId`) and pause the offending connector from the admin tools.

## Verify recovery

- `waiting` trends down; `analivo_job_last_success_timestamp_seconds` is fresh for every enabled job.
- The scheduler probe shows no overdue jobs.

## Escalate

Backlog still growing after the worker is healthy and scaled: page the engineering lead with the queue name, oldest job age and the top failing error.
