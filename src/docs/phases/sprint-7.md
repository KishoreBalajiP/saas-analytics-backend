# Sprint 7 — Governance (Audit + Access + Compliance)

> **WHAT this is:** the plan for Sprint 7 — audit logs, access logs,
> compliance (GDPR / CCPA-style) endpoints.
> **WHY it exists:** the `audit` plugin already emits events (Sprint
> 0); Sprint 7 wires the consumer + the public surface.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-7.md`.

---

## Purpose

> **WHAT this is:** the plan for Sprint 7 — Governance.
> **WHY it exists:** the `audit` plugin already emits events; Sprint 7
> wires the consumer + the public surface.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-7.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 7 implementer** | Has the full plan. |
| **Compliance officer** | Has the GDPR / CCPA surface. |

## Current Status

> **Status:** `Planned`.
> **Sprint:** Sprint 7.
> **Owner:** Engineering team.

## Business Perspective

Enterprise customers and regulators ask for two things: an audit log
of every mutation, and a compliance flow for data-subject requests.
Sprint 7 ships both.

## Technical Perspective

`AuditLog`, `AccessLog`, `ComplianceRequest` models. The `audit`
plugin (Sprint 0) already emits events; Sprint 7 subscribes a
consumer that persists them. Access log is captured via middleware
on every authenticated request. Compliance endpoints are admin-
gated for export / delete / restrict.

## Scope

### Audit logs
- Captures `{ actorType, actorId, tenantId, module, action,
  resource, before, after, reason, ip, userAgent, requestId,
  result }`.
- Sensitive fields stripped before persistence.
- TTL index on `createdAt` (30 days hot).
- `jobs/cleanup.job.js` deletes past TTL.

### Access logs
- Per-request: `{ actorId, method, path, statusCode, latencyMs,
  requestSize, responseSize, ip, userAgent, requestId, error }`.
- Token redaction (`Bearer ***`).
- Never logs response body (size only).
- TTL 7 days hot.

### Compliance
- Admin-gated: export, delete, restrict.
- Subject lookup by email.
- Audit row emitted even for "no data found" (proof of search).

## Deliverables

### Models
- `src/models/AuditLog.js`
- `src/models/AccessLog.js`
- `src/models/ComplianceRequest.js`

### Services
- `src/modules/governance/audit-logs/audit-log.service.js`
- `src/modules/governance/access-logs/access-log.service.js`
- `src/modules/governance/compliance/compliance.service.js`

### Middleware (real)
- `src/middleware/audit.middleware.js` — `audit(module, action)`
- `src/middleware/accessLog.middleware.js` — `accessLog`
- `src/middleware/compliance.middleware.js` — `annotate`,
  `blockIfDeleted`, `blockIfRestricted`

### Routes (real)
- `src/routes/audit-log.routes.js`
- `src/routes/access-log.routes.js`
- `src/routes/compliance.routes.js`

### Job (real)
- `src/jobs/cleanup.job.js` — deletes past-TTL records.

### Consumer
- `services/audit.service.js` — subscribes to `audit` events and
  persists structured records.

## Dependencies

- Sprint 0 (`audit` plugin) + Sprint 5 (email for compliance
  notifications).

## Testing

- Unit: sensitive-field redaction; TTL enforcement; compliance
  search.
- Integration: a mutation emits an audit row; a request emits an
  access row; a compliance export returns the subject's data.

## Risks

1. **Audit-write latency** on hot paths. Use
   `services/queue.service.js` to enqueue audit events; consumer
   drains with batching.
2. **Hash-chain gaps** on failed inserts. Sequential IDs in MVP;
   hash-chain is Phase 3.
3. **Sensitive-field redaction** must be exhaustive. Test against
   the canonical field list (`password`, `token`, `apiKey`,
   `secret`, `connectionString`, etc.).

## Definition of Done

- [ ] All deliverables merged.
- [ ] Every mutation in Sprints 1–6 emits an audit row.
- [ ] Every authenticated request emits an access row.
- [ ] Compliance export / delete / restrict work end to end.
- [ ] TTL indexes + cleanup job run.
- [ ] 90 %+ test coverage.
- [ ] `STATUS.md` updated.

## Expected Outcome

The platform is auditable and compliant. Every mutation is recorded;
every request is logged; data-subject requests work.

## Best Practices

| Do | Why |
| --- | --- |
| **Redact before persistence.** | Logs and audit tables leak secrets if you forget. |
| **Use the queue.** | Audit write must not block the request handler. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Logging response bodies.** | They contain tenant data; logs become a breach vector. |

---

## Summary

Sprint 7 ships governance: audit logs, access logs, compliance
endpoints. After Sprint 7 the platform is auditable.

## Key Takeaways

- **Audit on every mutation.** The plugin (Sprint 0) emits the event;
  Sprint 7 persists it.
- **Access on every request.** Middleware captures size-only
  responses.
- **Compliance is admin-gated.** Public endpoint via signed token is
  Phase 3.

## Interview Preparation

### Common Questions

- "How do you audit a mutation?"
- "How do you handle GDPR data-subject requests?"

### Sample Answers

- **"Audit?"** — The `audit` plugin emits a structured event on every
  `save` / `findOneAndUpdate`. The Sprint 7 consumer subscribes to
  those events and persists them as `AuditLog` rows. Sensitive fields
  are redacted before persistence.

- **"GDPR?"** — Subject lookup by email; admin-gated
  `/compliance/export` returns the subject's data;
  `/compliance/delete` hard-deletes the subject's tenant-owned
  records; `/compliance/restrict` flags the subject as restricted.
  Every compliance action emits its own audit row, even for "no
  data found" (proof of search).

### Real-World Examples

- A customer asks for their data. The compliance officer runs
  `/compliance/export?email=user@example.com`. The system returns a
  JSONL export of every tenant-owned record for that email. The
  export is logged in the audit trail.

### Common Mistakes

- Logging response bodies. They contain tenant data.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-6.md`](./sprint-6.md) — previous (Master Data)
- [`sprint-8.md`](./sprint-8.md) — next

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Sprint planned:** Sprint 7
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)