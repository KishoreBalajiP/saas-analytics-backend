# Governance / audit-logs

Audit Logs capture **meaningful state changes** with rich enough context
to answer "who did what, when, to which record, and why". They are the
source of truth for compliance and incident response.

## Why it exists

A SaaS without a complete audit trail can't be sold into regulated
industries. Customers ask "who deleted this dashboard?" - audit logs
turn that from a forensic nightmare into a one-line query.

## What we capture

Each event:

```
eventId, occurredAt,
actorType: 'admin' | 'user' | 'service' | 'system',
actorId,
actorDisplay,
tenantId | null,
module,                                // e.g. 'iam.admins'
action,                                // e.g. 'suspend'
resourceType, resourceId,              // affected entity
before?, after?,                       // diff (Phase 2 deeper diffs)
reason?,                               // required for sensitive ops
ip, userAgent,
requestId,                             // ties to access logs
result: 'success' | 'failure',
errorCode?
```

## Architectural shape

- Service: `src/services/auditLog.service.js` - the single write entry
  point used by `audit.middleware.js` AND by services emitting domain
  events directly.
- Repository: `src/repositories/auditLog.repository.js` - lean write +
  query interface; uses Mongo's time-series collection (Phase 3+).
- API: `src/routes/audit-log.routes.js` mounted at `/api/v1/audit-logs`.

## Planned endpoints (`/api/v1/audit-logs`)

- `GET    /`                  - filter + paginate (admin/RBAC)
- `GET    /:id`               - fetch one
- `POST   /export`            - request an export (long-running, queued)
- `GET    /export/:id`        - check export status (presigned URL)
- `GET    /modules/:module`   - convenience filter by module

## Coding guidelines

- Audit log writes MUST be append-only; never update / delete except via
  the retention pipeline.
- Every state-changing handler runs through `audit.middleware.js`.
- Sensitive payloads (passwords, tokens) MUST be redacted before they
  reach the audit logger.
- Storage tier: hot for 30 days, cold (S3) thereafter (Phase 3+).

## Future extension

- Hash-chained per-tenant (tamper-evidence).
- SIEM integration (Splunk / Elastic / DataDog).
- Compliance-export templates (SOC 2, ISO 27001).
