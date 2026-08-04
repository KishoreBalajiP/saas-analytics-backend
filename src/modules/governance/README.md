# Governance - Audit, Access, Compliance

Governance is the platform's **trace**: it captures every consequential
event so the company can investigate incidents, prove compliance and
answer customer "who did what" questions.

## Submodules

| Submodule       | Responsibility                                           | Entry file                     |
| --------------- | -------------------------------------------------------- | ------------------------------ |
| `audit-logs`    | `who / did what / when / to which resource / why`        | `routes/audit-log.routes.js`   |
| `access-logs`   | `who / requested which URL / when / with which outcome`  | `routes/access-log.routes.js`  |
| `compliance`    | GDPR data-subject requests, retention, evidence          | `routes/compliance.routes.js`  |

## Architectural principles

1. **Append-only.** Governance records are never updated or deleted except
   via the documented retention pipeline. Deletes are themselves audited.
2. **Write-path is mandatory.** Any request that *mutates* must pass
   through `audit.middleware.js`; any authenticated request must pass
   through `accessLog.middleware.js`. This is enforced at the route layer.
3. **Tenant-scoped, but platform-visible.** A tenant can query its own
   governance records; Platform Admins can query cross-tenant data subject
   to their permission.
4. **PII-safe.** Records store identifiers (id, email), never raw secrets.
   Field-level encryption via `src/utils/encryption.js` for sensitive items.
5. **Immutable retention.** Period beyond which a record is purged
   is itself a platform setting (default 7 years for compliance, 90 days
   for access logs).

## Responsibilities per submodule

### `governance/audit-logs/`
- Records every *meaningful change* (create/update/delete/approve/suspend/...)
  in the form `{ actorId, actorType, action, module, resource, before, after,
  reason, ip, userAgent, requestId, tenantId, occurredAt }`.
- Surfaced via `routes/audit-log.routes.js` (search + export).
- Source of truth: `repositories/auditLog.repository.js`.

### `governance/access-logs/`
- Records every authenticated HTTP request as access events
  `{ actorId, actorType, method, path, statusCode, latencyMs, ip,
  userAgent, requestId, tenantId, occurredAt }`.
- Surfaced via `routes/access-log.routes.js` (filter, paginate, aggregate).
- Higher volume than audit logs - ships to storage tier after N days.

### `governance/compliance/`
- Handles GDPR / CCPA-style requests: data export, delete, restrict,
  portability, consent withdrawal.
- Generates evidence: `{ requestId, requesterId, subjectId, type, status,
  evidenceObjectKey, dueBy, completedAt }`.
- Wires into `audit-logs/` for "compliance.requested" events and into
  `queues/` for long-running export jobs.

## Relationship with other modules

- **Every** module must cooperate with Governance: middleware enforces it.
- `platform/settings/` owns retention windows.
- `queues/` carry export jobs to `storage/` for delivery.

## Future implementation (Phase 2+)

- A retention cron (`platform/scheduler/`) that purges expired records.
- An export pipeline that streams results to a `storage/presignedUrl` URL
  and emails the requester.
- Tamper-evidence (hash chain per tenant per day).
- SIEM forwarder for `audit-logs` (Splunk / DataDog / Elastic).

## Coding guidelines

- Governance controllers are read-mostly; the only "writes" are
  retention-purge (privileged) and evidence tagging.
- All three modules share the same `requestId` (already provided by
  `requestId.middleware.js`) so a single UI can correlate the three.
- Compliance data-subject requests **always** include an `audit-logs` entry,
  even when no business data is found (proof of search is itself a record).

See each `governance/<submodule>/README.md` for details.
