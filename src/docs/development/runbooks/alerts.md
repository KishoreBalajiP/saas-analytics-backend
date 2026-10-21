# Alert rules

Prometheus alerting rules for the series served at `GET /api/v1/metrics`
(scrape with `authorization: { credentials: <METRICS_TOKEN> }`). Every series
is per process, so aggregate with `sum by (...)` across instances. Tune the
thresholds after two weeks of real traffic.

Also configure, outside Prometheus:

- an uptime check on `GET /api/v1/health/ready` from outside the platform
  (alert after 2 consecutive failures, 1-minute interval);
- error-tracker alerts on new issues and on spikes (the reporter sends API 5xx,
  failed scheduled jobs, queue jobs that ran out of retries, process crashes and
  frontend errors).

```yaml
groups:
  - name: analivo
    rules:
      - alert: AnalivoNotReady
        expr: min by (instance) (analivo_dependency_up{dependency=~"database|redis|queue"}) == 0
        for: 2m
        labels: { severity: page }
        annotations:
          summary: "{{ $labels.instance }} cannot serve traffic"
          runbook: src/docs/development/runbooks/database-down.md

      - alert: AnalivoDependencyDown
        expr: max by (dependency) (analivo_dependency_up) < 1
        for: 5m
        labels: { severity: ticket }
        annotations:
          summary: "Dependency {{ $labels.dependency }} is degraded or down"
          runbook: src/docs/development/runbooks/README.md

      - alert: AnalivoHighErrorRate
        expr: |
          sum(rate(analivo_http_requests_total{status=~"5.."}[5m]))
            / clamp_min(sum(rate(analivo_http_requests_total[5m])), 1e-9) > 0.02
        for: 5m
        labels: { severity: page }
        annotations:
          summary: "More than 2% of API requests fail with 5xx"
          runbook: src/docs/development/runbooks/high-error-rate.md

      - alert: AnalivoHighLatency
        expr: |
          histogram_quantile(0.95, sum by (le) (rate(analivo_http_request_duration_seconds_bucket{route!="<unmatched>"}[5m]))) > 2
        for: 10m
        labels: { severity: ticket }
        annotations:
          summary: "API p95 latency above 2 s"
          runbook: src/docs/development/runbooks/high-error-rate.md

      - alert: AnalivoAnalyticsTimeouts
        expr: sum(rate(analivo_analytics_queries_total{outcome=~"timeout|rejected"}[10m])) > 0.1
        for: 10m
        labels: { severity: ticket }
        annotations:
          summary: "Analytics queries time out or are refused"
          runbook: src/docs/development/runbooks/high-error-rate.md

      - alert: AnalivoQueueUnreachable
        expr: min by (queue) (analivo_queue_up) == 0
        for: 2m
        labels: { severity: page }
        annotations:
          summary: "Queue {{ $labels.queue }} transport (Redis) does not answer"
          runbook: src/docs/development/runbooks/redis-down.md

      - alert: AnalivoQueueBacklog
        expr: max by (queue) (analivo_queue_jobs{state="waiting"}) > 500
        for: 15m
        labels: { severity: ticket }
        annotations:
          summary: "{{ $labels.queue }} has {{ $value }} waiting jobs"
          runbook: src/docs/development/runbooks/queue-backlog.md

      - alert: AnalivoJobNotSucceeding
        # Every-minute jobs (report schedule, alert evaluation) silent for 15 min.
        expr: time() - max by (job) (analivo_job_last_success_timestamp_seconds{job=~"report-schedule|alert-evaluation|stale-job-recovery"}) > 900
        for: 5m
        labels: { severity: page }
        annotations:
          summary: "Scheduled job {{ $labels.job }} has not succeeded recently"
          runbook: src/docs/development/runbooks/queue-backlog.md

      - alert: AnalivoEmailFailures
        expr: sum(rate(analivo_email_sends_total{outcome="failed"}[15m])) > 0 and sum(rate(analivo_email_sends_total{outcome="sent"}[15m])) == 0
        for: 15m
        labels: { severity: page }
        annotations:
          summary: "Email sends are failing and none succeed"
          runbook: src/docs/development/runbooks/email-failures.md

      - alert: AnalivoAuthFailureSpike
        expr: sum(rate(analivo_auth_failures_total[5m])) > 5
        for: 10m
        labels: { severity: ticket }
        annotations:
          summary: "Authentication failures above 5/s"
          runbook: src/docs/development/runbooks/security-alert-triage.md

      - alert: AnalivoErrorReportsFailing
        expr: sum(rate(analivo_error_reports_total{result="failed"}[15m])) > 0
        for: 15m
        labels: { severity: ticket }
        annotations:
          summary: "The error reporter cannot deliver to ERROR_REPORTER_URL"
          runbook: src/docs/development/runbooks/high-error-rate.md
```

Job names in `analivo_job_*` series are the scheduler's registered names
(see `GET /monitoring/health/scheduler`); adjust the regex if they change.
