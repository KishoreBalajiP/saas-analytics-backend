# Governance / access-logs

Access Logs capture **every authenticated HTTP request** that hits the
API. They have higher cardinality than Audit Logs and serve different
purposes: behaviour analytics, debugging "why was this slow?", abuse
detection, support tooling.

## Why it exists

An audit log says "an admin suspended a tenant"; an access log says "in
the past hour, 17,403 requests hit `/api/v1/tenants`, of which 23
returned 5xx, of which 12 were from this IP". Complementary.

## What we capture

```
eventId, occurredAt,
actorId?, actorType?,
tenantId? | null,
method, path, statusCode,
latencyMs, requestSize, responseSize,
ip, userAgent,
requestId,                             // ties to audit logs
apiKeyId?,                             // when called via API key
error?: { code, message },
```

Unauthenticated requests (401) are recorded too, but with `actorId: null`.

## Architectural shape

- Middleware: `src/middleware/accessLog.middleware.js` - the single
  capture point, mounted globally after `requestId.middleware.js`.
- Service: `src/services/accessLog.service.js` - batched write (avoid
  hot-path latency).
- Repository: `src/repositories/accessLog.repository.js` - Mongo + future
  cold-storage tier.
- API: `src/routes/access-log.routes.js` mounted at `/api/v1/access-logs`.

## Planned endpoints (`/api/v1/access-logs`)

- `GET    /`                 - filter + paginate
- `GET    /top-paths`        - aggregated top paths (admin-only)
- `GET    /top-errors`        - aggregated error rates
- `POST   /export`            - export to presigned URL

## Coding guidelines

- Capture runs on `res.finish` so latency includes full response.
- Never log the response body (size only).
- Token redaction in header capture (Authorization becomes `Bearer ***`).
- Storage tier: hot 7 days, cold 90 days, then purge.

## Future extension

- OpenTelemetry export (OTLP) for centralised observability.
- Per-tenant quota tracking (rate-limit analytics).
