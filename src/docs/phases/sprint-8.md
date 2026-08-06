# Sprint 8 — Monitoring + Support

> **WHAT this is:** the plan for Sprint 8 — health probes for every
> subsystem, monitoring dashboard, support-engineer impersonation.
> **WHY it exists:** operators need to know what is broken and where;
> support engineers need an escape hatch to debug on behalf of
> tenants.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-8.md`.

---

## Purpose

> **WHAT this is:** the plan for Sprint 8 — Monitoring + Support.
> **WHY it exists:** operators need to know what is broken; support
> engineers need an escape hatch.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-8.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 8 implementer** | Has the full plan. |
| **Operator / on-call** | Has the dashboard. |

## Current Status

> **Status:** `Planned`.
> **Sprint:** Sprint 8.
> **Owner:** Engineering team.

## Business Perspective

The MVP ships without monitoring and without a support escape hatch.
Sprint 8 closes both gaps with the smallest useful surface.

## Technical Perspective

Each probe has a 2-second timeout. `/monitoring/aggregate` is
cached 5 s. `/support/impersonate` requires a mandatory `reason` and
a daily cap per admin.

## Scope

### Monitoring
- `/monitoring/system` — process uptime, memory, CPU.
- `/monitoring/db` — MongoDB connection + ping.
- `/monitoring/websocket` — Socket.IO room count.
- `/monitoring/queue` — queue depth (Phase 3, deferred).
- `/monitoring/scheduler` — registered cron jobs (Phase 3, deferred).
- `/monitoring/storage` — S3 ping (Phase 3, deferred).
- `/monitoring/connectors` — registered connectors (Phase 3,
  deferred).
- `/monitoring/aggregate` — 5 s cached rollup.

### Support
- `/support/impersonate` — short-lived impersonation token;
  mandatory reason; daily cap per admin.
- `/support/account-recover` — admin-only password reset on behalf of
  a user.
- Per-admin daily impersonation cap (default 20).
- Audited twice (audit + access).

## Deliverables

### Routes (real)
- `src/routes/monitoring.routes.js`
- `src/routes/support.routes.js`

### Services
- `src/modules/platform/monitoring/monitoring.service.js`
- `src/modules/platform/support/support.service.js`

### Probes
- `src/modules/platform/monitoring/probes/{system,db,websocket}.js`

## Dependencies

- Sprint 7 (audit + access logs).

## Testing

- Unit: each probe times out cleanly; aggregate caches for 5 s.
- Integration: an impersonation with no `reason` is rejected; an
  admin over the daily cap is rejected; impersonation events are
  logged twice.

## Risks

1. **Impersonation abuse.** Mandatory reason + daily cap + double
   logging are the controls. Test them.
2. **Probe timeouts.** A probe that hangs blocks the dashboard.
   2-second timeout per probe.
3. **Cache invalidation.** `/aggregate` must invalidate when a probe
   status changes.

## Definition of Done

- [ ] All deliverables merged.
- [ ] `/monitoring/system`, `/monitoring/db`, `/monitoring/websocket`,
      `/monitoring/aggregate` work.
- [ ] `/support/impersonate` requires reason; daily cap enforced.
- [ ] Every impersonation emits audit + access log entries.
- [ ] 90 %+ test coverage.
- [ ] `STATUS.md` updated.

## Expected Outcome

Operators can see what is broken. Support engineers can impersonate
tenants safely.

## Real-world Examples

- A customer reports their dashboard is missing charts. The on-call
  operator opens `/monitoring/aggregate` and sees the queue is
  stalled. They restart the worker; the dashboard is back.
- A support engineer impersonates a Tenant Owner to debug a login
  issue. The audit log records actor, target, reason and window.

## Best Practices

| Do | Why |
| --- | --- |
| **Time-box every probe.** | A probe that hangs blocks the dashboard. |
| **Double-log impersonation.** | Audit + access; the customer can see their own audit row. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Allowing impersonation without a reason.** | The reason is mandatory; it is the audit trail. |

---

## Summary

Sprint 8 ships monitoring probes and the support impersonation
escape hatch. After Sprint 8 operators and support engineers have the
tools they need.

## Key Takeaways

- **Probes are time-boxed** (2 s each).
- **Impersonation is doubly-logged** and capped.

## Interview Preparation

### Common Questions

- "How do you implement safe impersonation?"

### Sample Answers

- **"Safe impersonation?"** — Mandatory `reason` field; daily cap per
  admin; the impersonation window is recorded as an audit row and
  again as an access log entry; the customer can see their own audit
  row; the impersonation token is short-lived and revoked at logout.

### Real-World Examples

- A support engineer impersonates a Tenant Owner. The audit log
  captures actor, target, reason and window. The customer sees the
  impersonation in their audit log.

### Common Mistakes

- Allowing impersonation without a reason.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-7.md`](./sprint-7.md) — previous
- [`sprint-9.md`](./sprint-9.md) — next

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Sprint planned:** Sprint 8
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)