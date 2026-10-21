# Runbook: high error rate or latency

**Alerts:** `AnalivoHighErrorRate`, `AnalivoHighLatency`, `AnalivoAnalyticsTimeouts`, error-tracker spike, many frontend error reports.
**Impact:** depends on the routes. Check scope first.

## Confirm and scope

1. Which routes? `topk(10, sum by (route, status) (rate(analivo_http_requests_total{status=~"5.."}[5m])))`. Route labels are templates (`/api/v1/connectors/:id`), so one tenant's ids never split a series.
2. Which errors? `topk(10, sum by (code) (rate(analivo_api_errors_total[5m])))`, and the error tracker grouped by fingerprint.
3. Since when? Compare with the last deploy time. A step change at deploy time means roll back first and debug later.
4. Is a dependency failing? `/api/v1/health/ready` and the admin Monitoring page. If yes, use that dependency's runbook.
5. Frontend only? Error-tracker events with `source: frontend` (from `POST /api/v1/client-errors`). Their `context.apiRequestId` links to the failed API call.

## Act

1. **Bad deploy:** roll back. Then reproduce from the error tracker event (`request.route`, `error.stack`, `trace.traceId`).
2. **Analytics timeouts or `429 QUERY_CONCURRENCY_LIMIT`:** a tenant is running heavy dashboards. `analivo_analytics_query_duration_seconds` shows the latency, logs show the tenant. Limits are `ANALYTICS_QUERY_TIMEOUT_MS` and `ANALYTICS_MAX_CONCURRENT_QUERIES_PER_TENANT`. Scale the database before raising them.
3. **Quota rejections** (`analivo_quota_rejections_total`) are expected behaviour (4xx). Investigate only if a plan's limits look wrong.
4. **Latency without errors:** check the event loop (`analivo_nodejs_eventloop_lag_p99_seconds`), memory (`analivo_process_resident_memory_bytes`) and database latency. Scale the web service if CPU-bound.
5. **One user reports an error:** ask for the reference ID shown in the error message and follow [Following one request](README.md#following-one-request).

## Verify recovery

5xx rate back under the alert threshold for 15 minutes; no new error-tracker issue groups.

## Escalate

No mitigation within 30 minutes on a SEV1/SEV2: page the engineering lead.
