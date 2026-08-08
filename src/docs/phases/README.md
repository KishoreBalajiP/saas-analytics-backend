# phases/ — Sprint & Phase Documentation

> **WHAT this is:** the sprint-by-sprint and phase-by-phase record.
> **WHY it exists:** every sprint must be reviewable in isolation.
> When someone asks *"what was Sprint 5?"*, the answer is a single
> file. When someone asks *"is Phase 2 done?"*, the answer is a
> table.
> **HOW to use it:** open a sprint file before opening its branch;
> open a phase file when planning a multi-sprint effort.
> **WHEN to update it:** at sprint close (sprint file) and at phase
> close (phase file). Both updates ship with the closing PR.
> **WHERE it lives:** `src/docs/phases/`.

---

## Purpose

> **WHAT this is:** the sprint-by-sprint and phase-by-phase record for
> the SaaS Analytics Platform.
> **WHY it exists:** every sprint must be reviewable in isolation;
> every phase must be summarisable in one table. A repository with
> ten sprints and seven phases is unmanageable without this folder.
> **HOW to use it:** open a sprint file before opening its branch;
> open a phase file when planning a multi-sprint effort.
> **WHEN to update it:** at sprint close (sprint file) and at phase
> close (phase file). Both updates ship with the closing PR.
> **WHERE it lives:** `src/docs/phases/`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Engineer opening the next sprint** | Reads the matching sprint file; sees scope, deliverables, dependencies, DoD. |
| **Tech lead planning a sprint** | Cross-references the phase file to see where this sprint sits. |
| **PM tracking progress** | Uses the phase tables to communicate timing. |
| **Interview candidate** | Reads sprint files end-to-end to understand the actual delivery sequence. |

## Current Status

> **Status:** `Maintained` — every sprint closure PR updates the
> matching sprint file and (when relevant) the matching phase file.
> **Sprint:** Sprint 3 closed; Sprint 4 (Connector Platform) in progress.
> **Owner:** Engineering team.

---

## File Index

### Phase documents

| File | Purpose |
| --- | --- |
| [`phase-1.md`](./phase-1.md) | Production backend foundation |
| [`phase-1.1.md`](./phase-1.1.md) | Connector & infrastructure architecture |
| [`phase-1.2.md`](./phase-1.2.md) | Platform management architecture |
| [`phase-2.md`](./phase-2.md) | Implementation (Sprints 0–9) |
| [`phase-3.md`](./phase-3.md) | Enterprise features (future) |
| [`phase-4.md`](./phase-4.md) | Advanced enterprise (future) |
| [`phase-5.md`](./phase-5.md) | Mobile apps & SDKs (future, exploratory) |
| [`phase-6.md`](./phase-6.md) | AI / ML features (future, exploratory) |
| [`phase-7.md`](./phase-7.md) | White-label / multi-operator (future, exploratory) |

### Sprint documents

| File | Purpose |
| --- | --- |
| [`sprint-0.md`](./sprint-0.md) | Shared implementation foundation |
| [`sprint-1.md`](./sprint-1.md) | Authentication |
| [`sprint-2.md`](./sprint-2.md) | IAM |
| [`sprint-3.md`](./sprint-3.md) | Multi-Tenancy (tenant lifecycle, onboarding, settings, feature flags) |
| [`sprint-4.md`](./sprint-4.md) | Connector Platform (CSV + Webhook connectors, sync engine) |
| [`sprint-5.md`](./sprint-5.md) | Platform (settings surface, feature flags surface, notifications) |
| [`sprint-6.md`](./sprint-6.md) | Master Data (countries, currencies, timezones, plans, languages) |
| [`sprint-7.md`](./sprint-7.md) | Governance (Audit + Access + Compliance) |
| [`sprint-8.md`](./sprint-8.md) | Monitoring + Support |
| [`sprint-9.md`](./sprint-9.md) | Analytics + Embed |

---

## Cross-references

- [`../README.md`](../README.md) — documentation homepage
- [`../STATUS.md`](../STATUS.md) — daily-read project state
- [`../TEMPLATE.md`](../TEMPLATE.md) — documentation standard
- [`../03-product-roadmap.md`](../03-product-roadmap.md) — phase-by-phase plan
- [`../04-business-flow.md`](../04-business-flow.md) — end-to-end story
- [`../05-user-journey.md`](../05-user-journey.md) — persona-by-persona
- [Repo-root `CHANGELOG.md`](../../../CHANGELOG.md) — chronological log

---

## Maintenance Rules

1. **Sprint closure PRs** update the matching sprint file *and* the
   matching phase file in the same commit.
2. **Phase completion** updates the phase file's status table and
   flips the matching row in [`STATUS.md`](../STATUS.md).
3. **Cross-references are real links.** Renaming a sprint file means
   fixing every link to it.

---

## Summary

This folder contains 7 phase files and 10 sprint files — every
delivery unit the platform has shipped, is shipping, or will ship.
The current files reflect Phase 1, Phase 1.1, Phase 1.2 and the
Sprint 0 close. Sprint 1–9 files are placeholders that will be
filled in as each sprint opens.

## Key Takeaways

- **Phases** are *delivery milestones*; **sprints** are *delivery units*.
- Every sprint file uses the same template; every phase file is a
  summary plus links to the sprints inside it.
- The folder is the canonical "what did we ship, what is left" view.

## Interview Preparation

### Common Questions

- "How do you keep a multi-year project organised?"
- "What is the difference between a sprint and a phase?"
- "How do you decide when a phase is complete?"

### Sample Answers

- **"How do you keep a multi-year project organised?"** — Two
  levels. *Sprints* are short cycles (one to two weeks each) where
  every commit is meant to ship something user-visible. *Phases* are
  longer arcs (a quarter or more) that group sprints into a coherent
  capability (foundation, IAM, RBAC, business features, enterprise
  features). The phases answer "what kind of capability"; the
  sprints answer "what concrete deliverable, by when".

- **"Sprint vs phase?"** — A sprint ships a *complete* user-visible
  feature (or the foundation needed to ship one next sprint). A
  phase ships a *capability* — e.g. Phase 3 ships "enterprise
  features" which is many sprints. The folder structure enforces
  the distinction: one file per phase, one file per sprint, the
  phase file links to the sprints.

- **"When is a phase complete?"** — When the *Completion Criterion*
  in its file holds. For Phase 2, the criterion is: a user can sign
  up → invite teammate → ingest CSV → build dashboard → share
  report → embed widget → revoke session, end to end, with auth +
  tenant isolation + RBAC on every step. Until that holds, Phase 2
  is `In Progress`.

### Real-World Examples

- A new engineer asks "what is Sprint 3?" They open
  [`sprint-3.md`](./sprint-3.md) and read Scope, Deliverables,
  Dependencies, Definition of Done in three minutes.
- A PM asks "when does RBAC land?" They open
  [`phase-2.md`](./phase-2.md) → Sprint 3 row → status: 🕓 Planned,
  ships after Sprint 2 (IAM) closes.

### Common Mistakes

- Treating phases as sprints (they are not — a phase has many
  sprints).
- Marking a phase complete before its Completion Criterion holds.
- Forgetting to update the matching sprint file in the closing PR.

## Related Documents

- [`../README.md`](../README.md) — documentation homepage
- [`../STATUS.md`](../STATUS.md) — daily-read project state
- [`../TEMPLATE.md`](../TEMPLATE.md) — documentation standard
- [`../03-product-roadmap.md`](../03-product-roadmap.md) — phase-by-phase plan

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)