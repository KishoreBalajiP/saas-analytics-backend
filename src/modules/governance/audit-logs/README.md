# Governance / audit-logs

Audit Logs capture **meaningful state changes** with rich enough context
to answer "who did what, when, to which record, and why". They are the
source of truth for compliance and incident response.

## Why it exists

A SaaS without a complete audit trail can't be sold into regulated
industries. Customers ask "who deleted this dashboard?" - audit logs
turn that from a forensic nightmare into a one-line query.

## What we capture

Each entry (see `src/models/AuditLog.js`):

```
_id, occurredAt,
category: 'change' | 'security',       // security = constants/securityEvents.js
severity: 'info'|'notice'|'warning'|'critical' | null,
actorType: 'admin' | 'user' | 'service' | 'system',
actorId, actorDisplay,
tenantId | null,
module,                                // e.g. 'iam.admins'
action,                                // e.g. 'update', 'auth.login.failed'
resourceType, resourceId,              // affected entity
before?, after?,                       // allow-listed fields only (changed fields for updates)
metadata?,                             // changedFields, bulk filter/counts, event details
reason?,
ip, userAgent, requestId,              // from the request context
result: 'success' | 'failure',
errorCode?,
seq, prevHash, hash, hashAlg, keyId    // tamper-evidence chain
```

Three layers write to the trail, all through `auditLog.service#emit`:

1. **Model rows** (audit plugin + consumer): create, update (save,
   `findOneAndUpdate`, `updateOne`), `updateMany` (filter + counts), single
   hard deletes (with what was deleted) and `deleteMany` (filter + count),
   `insertMany` (count + first ids), soft delete / restore. Payloads are reduced to the per-model allow-list in
   `src/models/plugins/auditPolicy.js`; bookkeeping-only writes and
   high-volume models (usage counters, ingested rows, query log,
   notifications, alert events, job/sync runs) write no rows.
2. **Domain events** emitted by services (`settings.updated`, ...).
3. **Security events** via `securityEvent()` (`src/services/securityEvent.service.js`),
   names in `src/constants/securityEvents.js`, including the rate-limited
   `request.denied` for every 401/403 refused by auth/authz middleware.

## Tamper evidence and immutability

- Every row is sealed into a hash chain (`src/utils/auditChain.js`);
  `node scripts/ci/verify-audit-chain.js` (read-only) reports edited,
  deleted or inserted rows. Set `AUDIT_CHAIN_KEY` so the chain is an HMAC
  that database credentials alone cannot rebuild, and store the printed head
  outside the database (`--expect-head` detects truncation).
- Application guard: every update/replace/delete family and `bulkWrite` is
  refused on `AuditLog` (and on `AccessLog` / `LoginAttempt`) except the
  retention purge.
- Database guard (operator): run the app with a MongoDB user that may only
  `insert` + `find` on `auditlogs` (role recipe in `src/models/AuditLog.js`).

## Architectural shape

- Service: `src/services/auditLog.service.js` - the single write entry
  point used by the audit consumer, services and `securityEvent()`.
- Repository: `src/repositories/auditLog.repository.js` - chained insert +
  query interface.
- API: `src/routes/audit-log.routes.js` mounted at `/api/v1/audit-logs`.

## Endpoints (`/api/v1/audit-logs`)

- `GET    /`                  - filter + paginate (admin/RBAC; `category`, `severity`, ...)
- `GET    /:id`               - fetch one
- `POST   /export`            - request an export (long-running, queued)
- `GET    /export/:id`        - check export status (presigned URL)
- `GET    /modules/:module`   - convenience filter by module

## Coding guidelines

- Audit log writes MUST be append-only; never update / delete except via
  the retention pipeline.
- New audited models need an entry in `auditPolicy.js` (a test enforces it).
- New security events go into `src/constants/securityEvents.js` first.
- Never pass secrets to `emit` / `securityEvent`; credential-like keys are
  redacted anyway (`src/utils/auditPayload.js`).
- Storage tier: hot for 30 days, cold (S3) thereafter (Phase 3+).

## Future extension

- SIEM integration (Splunk / Elastic / DataDog).
- Compliance-export templates (SOC 2, ISO 27001).
