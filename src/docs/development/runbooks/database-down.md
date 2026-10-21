# Runbook: database down

**Alerts:** `AnalivoNotReady`, `AnalivoDependencyDown{dependency="database"}`, uptime check on `/api/v1/health/ready` failing.
**Impact:** every API call that touches data fails. SEV1 when it affects all instances.

## Confirm

1. `curl -s https://<api>/api/v1/health/ready` returns 503 with `"database":"down"`.
2. `GET /api/v1/health` still returns 200 with `"db":"disconnected"`. That is expected: liveness does not depend on the database.
3. Logs show `MongoDB connection error`, `MongoDB disconnected` or `MongoDB background reconnect failed` (with an `attempt` number).
4. Check the provider (MongoDB Atlas status page and the cluster's metrics: connections, CPU, primary elections).

## Act

1. **Do not restart instances first.** A web instance that lost the database keeps reconnecting by itself (exponential backoff up to `MONGODB_RECONNECT_MAX_DELAY_MS`, 30 s by default) and starts its background work once connected. While it is down it answers 503 on readiness, so the platform stops routing traffic to it.
2. Worker instances exit when the database is missing at boot and the platform restarts them. Expect restart loops on the worker until the database is back. This is intended.
3. If only one instance is affected, compare its `MONGODB_URI` and network path with a healthy one (DNS, IP allow-list in Atlas, VPC peering).
4. If the cluster is at its connection limit, lower `MONGODB_MAX_POOL_SIZE` (per instance) or scale the cluster. The total is pool size × instances.
5. If a deploy started it, roll back (Render: "Rollback to previous deploy").

## Verify recovery

- Logs show `MongoDB connected after background reconnect` and `Background work started`.
- `/api/v1/health/ready` returns 200 (`ready` or `degraded`) on every instance.
- `analivo_http_requests_total{status=~"5.."}` falls back to baseline.
- `GET /monitoring/health/scheduler` shows the every-minute jobs running again. Reports and alerts that were due during the outage run on the next tick.

## Escalate

Atlas incident or data-loss suspicion: open a support case with MongoDB and page the engineering lead.
