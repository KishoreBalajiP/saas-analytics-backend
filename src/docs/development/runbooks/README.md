# On-call runbooks

Short, action-first guides for the incidents Analivo's alerts page you for.
Each runbook says how to confirm the problem, what to do first, and when to
escalate. Keep them current: if a step was wrong during an incident, fix the
runbook in the same week.

| Runbook | Typical alert |
| --- | --- |
| [Database down](database-down.md) | `AnalivoNotReady`, `AnalivoDependencyDown{dependency="database"}` |
| [Redis down](redis-down.md) | `AnalivoDependencyDown{dependency="redis"}`, `AnalivoQueueUnreachable` |
| [Queue backlog](queue-backlog.md) | `AnalivoQueueBacklog`, `AnalivoJobNotSucceeding` |
| [Email failures](email-failures.md) | `AnalivoEmailFailures`, `AnalivoDependencyDown{dependency="smtp"}` |
| [High error rate](high-error-rate.md) | `AnalivoHighErrorRate`, `AnalivoHighLatency`, error-tracker spike |
| [Security alert triage](security-alert-triage.md) | `AnalivoAuthFailureSpike`, security event notifications |

Alert rules (Prometheus syntax) are in [alerts.md](alerts.md).

## Where to look

| Signal | Where | Notes |
| --- | --- | --- |
| Liveness | `GET /api/v1/health` | Always 200 while the process runs. Never restart on this alone. |
| Readiness | `GET /api/v1/health/ready` | 200 `ready` / 200 `degraded` / 503 `not_ready`. Body lists each dependency as `ok`, `degraded`, `down`, `disabled` or `unknown`. Point the platform health check and the uptime monitor here. |
| Public status | `GET /api/v1/status` | Customer-safe summary: `operational`, `degraded` or `outage` per component. |
| Admin health page | Admin portal, Monitoring (`/monitoring/health/aggregate`) | Every probe with latency and a short error. Needs `monitoring.view`. |
| Metrics | `GET /api/v1/metrics` | Prometheus text, bearer `METRICS_TOKEN`. Per process: sum across instances. |
| Errors | The error tracker behind `ERROR_REPORTER_URL` | API 5xx, failed jobs, exhausted queue jobs, crashes and frontend errors. Scrubbed of secrets and PII. |
| Logs | Platform log stream (JSON) | Filter on `requestId` (what the user sees as "Reference ID"), `traceId` (follows a request into its jobs), `job`, `queue`, `jobId`. |

## Following one request

1. Get the reference ID from the user. The UI shows it in error messages and toasts, and it is the `X-Request-Id` response header.
2. Search the logs for `"requestId":"<id>"`. The access line, the error line and every service line of that request carry it.
3. Copy the `traceId` from one of those lines and search for it. That shows the queue jobs the request started (`queue`, `jobId`), including those that ran on the worker service.
4. If the request failed with a 5xx, the error tracker has an event whose `request.requestId` is the same id.

## Severity guide

| Severity | Meaning | Response |
| --- | --- | --- |
| SEV1 | API down for all tenants (`not_ready` on every instance, status `outage`) | Page now. Post on the status channel within 15 minutes. |
| SEV2 | A key feature is down or degraded for many tenants (jobs, email, exports, sign-in) | Page during business hours, otherwise next morning unless it is customer-facing. |
| SEV3 | Single tenant or cosmetic | Ticket. |

Security incidents follow [security-alert-triage.md](security-alert-triage.md) whatever the severity.
