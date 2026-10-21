# 12. Operations, monitoring, background jobs and incident management

**Audience:** whoever runs Analivo in production (today, the development team) and engineers improving its reliability.

**Summary.** Operability stops at a liveness probe and stdout logs. There is no CI, no infrastructure-as-code, no metrics, no alerting, no error aggregation, no backup or restore procedure, and no retention enforcement. Production MongoDB indexes are never created because `autoIndex` is disabled "for explicit migrations" that do not exist ({{OPS:indexes}}). Several reliability paths are wired incorrectly: an initial database failure leaves the process permanently degraded while `/health` still answers 200 ({{OPS:degraded}}); shutdown waits on Socket.IO clients and never drains queues ({{OPS:shutdown}}); the idempotency middleware and stale-job recovery exist but are never used ({{OPS:idempotency}}, {{CON:stale-dead}}); and cron runs in every web process without a lock ({{OPS:cron}}). The platform is operable as one hand-managed instance; it is not yet observable, recoverable, or safe to scale horizontally ({{OPS:single-process}}).

## 1. Current state (brief §13)

| Area | Status | Evidence / notes |
|---|---|---|
| Liveness `GET /api/v1/health` | **Implemented and verified** | Always 200 while the process runs; `tests/health.test.js` |
| Readiness `GET /api/v1/health/ready` | **Partially implemented** | Checks only the MongoDB connection; not Redis, storage, SMTP or queue workers |
| Database connect retry | **Partially implemented** | Retries at boot, then runs "degraded" forever if the first attempt fails; the connector consumer and scheduler start anyway |
| Structured logging | **Implemented but incompletely verified** | Pino JSON to stdout with path-based redaction (top-level keys only, {{GOV:log-redact}}); raw embed, invitation and compliance tokens appear in logged URLs ({{OPS:tokens-logged}}) |
| Request correlation | **Partially implemented** | `X-Request-Id` generated and returned; stored on audit and access records; the frontend neither sends nor shows it ({{OPS:request-id}}) |
| Error aggregation | **Missing** | No Sentry-style service; frontend errors go only to a Lovable reporter |
| Metrics (latency, error rate, query time, queue depth) | **Mocked or simulated** | `monitoring.service.getMetrics` and the queue, scheduler, storage and connector probes return "deferred" placeholders with HTTP 200 |
| Alerting and escalation | **Missing** | |
| Job and scheduler observability | **Mocked or simulated** | No run records, no last-run time, no failure counters |
| Provider failure signals (Mongo, Redis, SMTP, Razorpay) | **Partially implemented** | Logged when they occur; no health checks or alerts; the admin monitoring aggregate returns 500 when Redis is down ({{OPS:monitoring-500}}) |
| Rate-limit events | Logged | In-memory stores, per process |
| Backups and restore | **Planned or documented only** | Nothing in the repository describes backup, PITR or restore; the runbook does not cover it ({{OPS:backups}}) |
| Retention enforcement | **Planned or documented only** | Cleanup job is a stub ({{OPS:retention}}) |
| Configuration validation | **Implemented and verified** | Strong production gates (`backend/src/config/env.js:366-407`), but they run only when `NODE_ENV=production`, which no deploy artefact pins ({{OPS:node-env}}); two MongoDB timeout settings never reach the driver (`TimeoutMs` vs `TimeoutMS`) |
| Idempotency for POSTs | **Broken** | Middleware never mounted; the frontend sends a fresh key per request anyway, so retries are not deduplicated ({{OPS:idempotency}}) |
| CI/CD | **Missing** | No `.github/` in either repository; guards and tests run only on developer machines; the committed test logs record failing runs ({{OPS:no-ci}}) |
| Docker / compose | **Broken for local quick-start** | `docker-compose.yml` forces `NODE_ENV=production`, which the config gate rejects without Redis, S3 and SMTP; Dockerfile uses Node 22 while no version file pins the runtime |
| Secrets hygiene | **Risk** | `scripts/ci/run-tests.js:39-41` states the developer `.env` holds real production credentials; `npm run dev` would start the scheduler and workers against them ({{OPS:dev-creds}}) |

## 2. Background jobs and schedulers (brief §17.3)

| Job | Real work? | Default | Lock / idempotency | Observability |
|---|---|---|---|---|
| report-schedule (every minute) | Yes: enqueue due reports | Enabled | None; every instance runs it; `nextRunAt` advanced after enqueue | Logs only |
| alert-evaluation (every minute) | Yes | Enabled | None; invalid cron causes repeat firing ({{ANA:alert-cron}}) | Logs only |
| billing-reconcile | Yes | Disabled | Not assessed beyond scheduling | Logs only |
| anomaly, cleanup, email, sheet-sync | **No** (stubs) | Disabled | — | Log "stub - nothing to do" when enabled |
| stale-job recovery | **Dead code** (would crash on import) | Not registered | — | — |
| Connector sync consumer | Yes | Started after DB connect | Memory queue unless Redis; lost on restart; no per-connector lease | Connector fields only |
| Analytics worker (report/alert), export worker | Yes | Registered at import | Errors swallowed per job | Logs only |
| Email | Sent synchronously in request handlers | — | No outbox or retry | Logs only |

**Target design.**

1. Run queue consumers and the scheduler in a **separate worker service** (same image, different start command), not in web processes.
2. Use **BullMQ Job Schedulers** (`upsertJobScheduler`) for recurring work so exactly one job is produced per tick regardless of instance count, or node-cron's distributed mode with a Redis coordinator. Neither gives exactly-once execution, so every job must also be idempotent: claim due records with an atomic `findOneAndUpdate` lease, compute the next run before side effects, and key side effects (emails, events) by `(ruleId, period)`.
3. Record a `JobRun` (job, trigger, started, finished, status, counts, error) for every execution; expose last success, last failure and backlog per queue in monitoring; alert when a scheduled job has not succeeded within twice its interval.
4. Implement the cleanup job for real (retention per collection, with dry-run and report), and replace synchronous email with an outbox drained by the email job.
5. Graceful shutdown: stop accepting work, pause consumers, wait for in-flight jobs up to the timeout, close queues, Redis, Mongo and the mailer, then exit; close Socket.IO before `server.close()` resolves.

## 3. Monitoring and observability plan

| Layer | Signals | Implementation suggestion |
|---|---|---|
| Health | Liveness (process), readiness (Mongo ping, Redis ping, worker heartbeat freshness, storage write probe) | Point the Render health check at `/health/ready`; return 503 when a hard dependency fails |
| Metrics | HTTP rate, error rate and latency by route; Mongo command latency; aggregation duration by tenant; queue depth and age; job success/failure; email send success; provider errors | OpenTelemetry metrics or a Prometheus `/metrics` endpoint protected from public access; a hosted backend chosen by the team |
| Traces | Request → service → Mongo/queue spans with `requestId` as trace attribute | OpenTelemetry Node SDK |
| Errors | Backend unhandled and 5xx errors; frontend errors with route, release and request id | One error-aggregation service for both repositories; scrub personal data |
| Logs | Structured JSON with request id, tenant id, actor id; token values never logged | Fix URL-token logging; nested redaction |
| Dashboards | Golden signals per service; per-tenant query cost; job health; security alerts (document 11) | |
| Alerts | Readiness failing; error rate above baseline; p95 latency above objective; job not succeeded in 2× interval; queue age; Mongo connection saturation; certificate and domain expiry | Paging only for user-impacting symptoms |

**Service objectives to adopt after measurement.** This audit did not measure throughput, latency or availability, and none are claimed. Sensible first objectives to validate with a load test (document 16 §4): API availability, p95 latency for dashboard views, p95 widget execution time, sync completion time for a 10 MB CSV, and scheduled-report punctuality. Set the numeric targets from the first two weeks of real metrics.

## 4. Reliability and disaster recovery (brief §17.5)

| Question | Evidence in repository | Needed to establish capability |
|---|---|---|
| Is the database backed up? | None | Confirm the MongoDB host's backup or PITR configuration in its console; record RPO and retention |
| Can it be restored? | None | A quarterly restore drill into a scratch cluster with a checklist and timings (RTO), recorded as evidence |
| Object storage durability and retention | S3 driver exists; no lifecycle rules in code | Bucket versioning and lifecycle rules for exports and report artefacts |
| Configuration recovery | `.env.example` only; deploy settings live in Render/Vercel consoles | Environment inventory (names, owners, rotation dates) stored outside the app; infrastructure-as-code (`render.yaml`) |
| Restart behaviour | Memory queue loses jobs; connectors wedge in `running` | Durable queue + leases + reaper |
| Dependency outages | SMTP failure is surfaced to registration as `verificationSent: false`; Redis outage breaks admin monitoring; Mongo outage → permanent degraded mode | Readiness gating, retries with backoff, circuit breakers on providers |
| Tenant data export and restore | Not available | Owner-initiated export; documented per-tenant restore procedure from backups |

## 5. Incident management (brief §13.1)

Build a lightweight model on existing pieces rather than a new system:

| Element | Proposal |
|---|---|
| Detection | Alerts from section 3 and security alerts from document 11, plus customer reports through support |
| Record | An `Incident` collection (or an external tool the team already uses): id, title, severity (SEV1 full outage or data exposure, SEV2 major feature down or degraded for many tenants, SEV3 limited impact, SEV4 minor), status, commander, affected services and tenants, timeline entries, links to request ids and alerts |
| Communication | A public status page and an in-app banner driven by a platform setting (the per-tenant maintenance-notice key exists but nothing reads it) |
| Mitigation and resolution | Runbooks per alert; kill switches via feature flags; ability to pause schedulers and connectors per tenant |
| Review | Post-incident review within five working days for SEV1/SEV2, with follow-up tasks tracked to closure |
| Data incidents | A separate playbook for suspected cross-tenant exposure or credential leak: contain, preserve audit evidence, assess affected tenants, notify per contract and law |

## 6. Findings in this area

{{OPS:indexes}}, {{OPS:backups}}, {{OPS:node-env}}, {{OPS:dev-creds}}, {{OPS:degraded}}, {{OPS:shutdown}}, {{OPS:observability}}, {{OPS:monitoring-500}}, {{OPS:cron}}, {{OPS:single-process}}, {{OPS:idempotency}}, {{OPS:retention}}, {{OPS:tokens-logged}}, {{OPS:no-ci}}, {{OPS:request-id}}, {{CON:stale-dead}}, {{CON:wedge}}, {{ANA:alert-cron}}. Full details are in `19-findings-register.md`.

## Sources

- BullMQ Job Schedulers: https://docs.bullmq.io/guide/job-schedulers
- node-cron, running jobs across multiple servers: https://nodecron.com/run-cron-jobs-across-multiple-servers.md
- Render, cron jobs: https://docs.render.com/cronjobs
