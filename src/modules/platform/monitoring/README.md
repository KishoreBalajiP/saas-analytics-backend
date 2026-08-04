# Platform / monitoring

Monitoring exposes the **operational health** of every subsystem we own.
It is read-only and admin-gated; it never makes a decision, only reports.

## What we will monitor (Phase 2)

| Subsystem       | What we report                                              |
| --------------- | ----------------------------------------------------------- |
| System Health   | Process uptime, memory, event-loop lag, Node version        |
| Database Health | Mongo ping, replica lag, connection pool saturation         |
| WebSocket Health| Active connections, rooms, events/sec, errors               |
| Queue Health    | Queue depth, in-flight, retries, dead-letter                |
| Scheduler Health| Job counts, last-run, next-run, latency p50/p95             |
| Storage Health  | Provider up, recent operation latencies, errors             |
| Connector Health| Active connectors, last successful sync, failures           |

## Planned endpoints (`/api/v1/monitoring`)

- `GET /health/system`      - system load
- `GET /health/db`          - mongo ping + counts
- `GET /health/websocket`   - socket stats
- `GET /health/queue`       - queue depth + workers
- `GET /health/scheduler`   - registered + overdue jobs
- `GET /health/storage`     - provider latency test
- `GET /health/connectors`  - connector uptime
- `GET /health/aggregate`   - one-shot summary for status page
- `GET /metrics`            - prometheus exposition (Phase 4+)

Plus a public read-only endpoint mirroring `/health/aggregate` for the
customer-facing status page.

## Architectural shape

- Service: `src/services/monitoring.service.js` - thin facade that talks to
  each subsystem through `src/connectors`, `src/queues`, `src/storage`,
  `src/cache` and `src/jobs`.
- No repository: monitoring is computed, not persisted. Time-series
  metrics go through a Phase 4 plug-in.

## Coding guidelines

- Every health probe has a 2-second timeout; failures degrade gracefully.
- Probes never throw to the caller; they return structured results
  `{ status, latencyMs?, error? }`.
- Aggregates are cached for 5 seconds so `/aggregate` doesn't load the
  platform.
- Admin-only access; platform `support_admin` may read but not mute.

## Future extension

- Time-series storage (ClickHouse / Prometheus) for trend dashboards.
- Incident creation (links to a future `incidents/` module).
- Synthetic transactions (cron-based health).
