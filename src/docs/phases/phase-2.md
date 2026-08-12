# Phase 2 — Implementation (Sprints 0–9)

> **WHAT this is:** the record of Phase 2 — the MVP that turns the
> foundation into a usable product.
> **WHY it exists:** Phase 2 is ten sprints. Without a single
> document describing the whole phase, planning each sprint is a
> fresh exercise.
> **HOW to use it:** read the *Sprint Map* before planning a sprint;
> read the *Completion Criterion* before declaring Phase 2 done.
> **WHEN to update it:** as each sprint closes (the matching sprint
> file updates too).
> **WHERE it lives:** `src/docs/phases/phase-2.md`.

---

## Purpose

> **WHAT this is:** the record of Phase 2 — the MVP that turns the
> foundation into a usable product.
> **WHY it exists:** Phase 2 is ten sprints; without a single document
> describing the whole phase, planning each sprint is a fresh
> exercise.
> **HOW to use it:** read *Sprint Map* before planning a sprint; read
> *Completion Criterion* before declaring Phase 2 done.
> **WHEN to update it:** as each sprint closes.
> **WHERE it lives:** `src/docs/phases/phase-2.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint implementer** | Has the phase-level dependency map. |
| **Tech lead** | Has the dependency graph to plan capacity. |
| **PM** | Has the deliverable sequence to communicate timing. |
| **Interview candidate** | Has the canonical MVP delivery sequence. |

## Current Status

> **Status:** `In Progress` — Sprints 0–7 complete (Sprint 7 re-scoped
> to Reports, Alerts, Notifications & Scheduling); Sprints 8–9 planned.
> **Sprint:** Sprint 7 close — Reports, Alerts, Notifications &
> Scheduling (✅ complete).
> **Owner:** Engineering team.

## Business Perspective

Phase 2 delivers the **MVP**: a customer can sign up, invite users,
connect data, build dashboards, share reports and embed widgets —
end to end, on a production-grade, multi-tenant backend. Every
persona in [`05-user-journey.md`](../05-user-journey.md) is exercised
by at least one step in the flow in [`04-business-flow.md`](../04-business-flow.md).

## Technical Perspective

Ten sprints ship a vertical slice each: model → repository →
service → controller → route → middleware chain → test → docs → CI
guard update. The middleware chain is fixed by [`ARCHITECTURE.md`](../ARCHITECTURE.md);
Sprints 1–3 fill in the layers, Sprints 4–9 fill in the features.

## Architecture

```
Sprint 0 (Foundation — utilities, drivers, plugins)
    └─ Sprint 1 (Authentication: User, Admin, Session, JWT, MFA)
        └─ Sprint 2 (IAM: Tenant, Admin/Role/User CRUD, lifecycle, RBAC cache)
            └─ Sprint 3 (Multi-Tenancy: tenant lifecycle, onboarding, settings, feature flags)
                ├─ Sprint 4 (Connector Platform: CSV + Webhook connectors, sync engine)
                ├─ Sprint 5 (Analytics Engine + Master Data: query engine, reference catalogue)
                ├─ Sprint 6 (Dashboards & Widgets: authoring, lifecycle, sharing, execution, cache)
                ├─ Sprint 7 (Reports, Alerts, Notifications & Scheduling — re-scoped from Governance; ✅ complete)
                ├─ Sprint 8 (Monitoring + Support + Governance surfaces)
                └─ Sprint 9 (Analytics + Embed)
```

## Deliverables

| Sprint | File | Status |
| --- | --- | --- |
| Sprint 0 | [`sprint-0.md`](./sprint-0.md) | ✅ Complete |
| Sprint 1 | [`sprint-1.md`](./sprint-1.md) | ✅ Complete |
| Sprint 2 | [`sprint-2.md`](./sprint-2.md) | ✅ Complete |
| Sprint 3 | [`sprint-3.md`](./sprint-3.md) | ✅ Complete |
| Sprint 4 | [`sprint-4.md`](./sprint-4.md) | ✅ Complete (Connector Platform) |
| Sprint 5 | [`sprint-5.md`](./sprint-5.md) | ✅ Complete (Analytics Engine + Master Data) |
| Sprint 6 | [`sprint-6.md`](./sprint-6.md) | ✅ Complete (Dashboards & Widgets) |
| Sprint 7 | [`sprint-7.md`](./sprint-7.md) | ✅ Complete (Reports, Alerts, Notifications & Scheduling — re-scoped from Governance) |
| Sprint 8 | [`sprint-8.md`](./sprint-8.md) | 🕒 Planned (Monitoring + Support + Governance surfaces) |
| Sprint 9 | [`sprint-9.md`](./sprint-9.md) | 🕒 Planned |

## Dependencies

Phase 1 + Phase 1.1 + Phase 1.2.

## Completion Criterion

A user can:

1. Sign up → invite teammate → ingest CSV → build dashboard → share
   report → embed widget → revoke their session,
2. Every business endpoint has `authenticate` (or `adminAuth`) +
   `resolveTenant` + `tenantIsolation` + `rbac`/`permission` middleware,
3. Every mutation emits an `audit` plugin event (Sprint 0). Sprint 7
   ships Reports / Alerts / Notifications on top of the engine;
   the audit-event *consumer* that persists `AuditLog` rows is
   planned for Sprint 8 (originally planned for Sprint 7 — see
   [sprint-7.md](./sprint-7.md) for the re-scope note),
4. 90 %+ test coverage on the touched surfaces,
5. `npm run ci:guards` passes; `npm audit` reports 0 vulnerabilities.

When all five hold, Phase 2 is complete.

## Expected Outcome

A production-grade multi-tenant SaaS analytics platform that a small
team can ship to paying customers. All enterprise features are
deferred to Phase 3 with hooks already in place.

## Real-world Examples

The fictional company **Acme Logistics** walks through the full
Phase 2 flow in [`04-business-flow.md`](../04-business-flow.md). Each
step ties to a sprint here.

## Best Practices

| Do | Why |
| --- | --- |
| **Ship vertical slices, not horizontal layers.** | Every sprint ships a feature a customer can demo. |
| **Update the sprint file in the closing PR.** | Future contributors must see what shipped, not guess. |
| **Keep the dependency graph strict.** | Skipping a sprint to land a later one creates orphans. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Implementing a feature in the wrong sprint.** | The order is part of the design; reordering breaks the dependency graph. |
| **Marking Phase 2 complete before Sprint 9 ships.** | Phase 2 is "until a user can do the whole flow end to end"; missing any step breaks the criterion. |
| **Skipping the audit middleware on a "trivial" mutation.** | The `audit` plugin emits the event; Sprint 8 wires the consumer that persists `AuditLog` rows. If a mutation does not emit an audit event the log will be incomplete. |

---

## Summary

Phase 2 is ten sprints. Sprint 0 is the foundation and is complete;
Sprints 1–9 ship the MVP one vertical slice at a time. The order is
fixed; the dependency graph is strict; the Completion Criterion is
end-to-end demo-ability.

## Key Takeaways

- **Ten sprints, one vertical slice each.** Foundation → auth → IAM/RBAC
  → multi-tenancy → connectors → platform config → master data →
  governance → monitoring → analytics + embed.
- **Phase 2 is complete when the end-to-end demo works.** Not
  earlier.
- **Sprint 0 is the only sprint that ships infrastructure only.**
  Every other sprint ships a user-visible feature.

## Interview Preparation

### Common Questions

- "Why ten sprints for the MVP?"
- "Why this order?"
- "What if you wanted to ship in five sprints?"

### Sample Answers

- **"Why ten?"** — Each sprint ships a complete feature, not a
  partial one. Sprint 1 ships the entire login flow or nothing.
  Splitting further would mean half-finished features that cannot
  be demoed.

- **"Why this order?"** — Foundation before features, then auth
  before IAM, then RBAC before business features. The platform is
  fail-closed; the first sprint that *opens* the platform is
  Sprint 1, and every later sprint assumes auth + RBAC + tenant
  isolation exist.

- **"Five sprints?"** — We could merge Sprints 5+6 (platform config +
  master data) and Sprints 7+8 (governance + monitoring) but not the
  others. Auth + IAM + RBAC + multi-tenancy must be separate because
  each ships a distinct primitive the next depends on.

### Real-World Examples

- A sprint implementer opens [`sprint-4.md`](./sprint-4.md), reads
  Scope and Deliverables, and starts the first ticket.
- A PM reads the *Sprint Map* table and updates a public roadmap.

### Common Mistakes

- Treating sprints as interchangeable. They are not; the order is
  part of the design.
- Skipping a sprint because "we already know how". The order is the
  sequence in which primitives become available.

## Related Documents

- [`../README.md`](../README.md) — documentation homepage
- [`../STATUS.md`](../STATUS.md) — daily-read project state
- [`../03-product-roadmap.md`](../03-product-roadmap.md) — phase-by-phase plan
- [`../04-business-flow.md`](../04-business-flow.md) — end-to-end story
- [`../05-user-journey.md`](../05-user-journey.md) — persona-by-persona
- [`phase-1.md`](./phase-1.md) — previous phase
- [`phase-3.md`](./phase-3.md) — next phase
- [`sprint-0.md`](./sprint-0.md) → [`sprint-9.md`](./sprint-9.md)

## Last Updated

- **Sprint:** Sprint 7 close (Reports, Alerts, Notifications & Scheduling; re-scoped from Governance)
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-12
- **Author:** Engineering (Sprint 6 close, Sprint 5–6 re-scope)