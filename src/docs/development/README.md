# development/ — Engineering Practices

> **WHAT this is:** the engineering practices reference — coding
> standards, API standards, testing strategy, git workflow,
> environment setup, deployment, definition of done and
> documentation rules.
> **WHY it exists:** consistent practices are the difference between
> a codebase that scales and one that collapses under its own weight.
> **HOW to use it:** every contributor reads *Coding Standards* and
> *Definition of Done* before opening their first PR.
> **WHEN to update it:** when a practice changes.
> **WHERE it lives:** `src/docs/development/`.

---

## Purpose

> **WHAT this is:** the engineering practices reference.
> **WHY it exists:** consistent practices scale; inconsistent ones
> collapse.
> **HOW to use it:** every contributor reads *Coding Standards* and
> *Definition of Done* before opening their first PR.
> **WHEN to update it:** when a practice changes.
> **WHERE it lives:** `src/docs/development/`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **New engineer** | Has the practices to follow. |
| **Tech lead** | Has the checklist for reviews. |

## Current Status

> **Status:** `Maintained` — practices evolve with the codebase.
> **Sprint:** Always (continuous).
> **Owner:** Founding architect + Engineering team.

---

## Index

| Document | Purpose |
| --- | --- |
| [`coding-standards.md`](./coding-standards.md) | Lint, naming, file layout, JSDoc, comments |
| [`api-standards.md`](./api-standards.md) | Error envelope, versioning, idempotency |
| [`testing-strategy.md`](./testing-strategy.md) | Unit + integration + smoke |
| [`git-workflow.md`](./git-workflow.md) | Branches, commits, PR conventions |
| [`environment-setup.md`](./environment-setup.md) | Every env var documented |
| [`deployment.md`](./deployment.md) | Render, Railway, Docker, ECS |
| [`definition-of-done.md`](./definition-of-done.md) | What "done" means |
| [`documentation-rules.md`](./documentation-rules.md) | Keep docs in sync |

---

## Cross-references

- [`../README.md`](../README.md) — documentation homepage
- [`../STATUS.md`](../STATUS.md) — daily-read project state
- [`../TEMPLATE.md`](../TEMPLATE.md) — documentation standard
- [`../01-getting-started.md`](../01-getting-started.md) — onboarding
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — system architecture

---

## Maintenance Rules

1. **Practices evolve with the codebase.** When the codebase
   changes, the matching doc updates in the same PR.
2. **Examples are real.** Pseudocode is forbidden.
3. **Cross-references are real links.**

---

## Summary

This folder holds the engineering practices. Every contributor
follows them; every reviewer checks against them.

## Key Takeaways

- **One set of practices** across the team.
- **Practices are CI-enforced** where possible.

## Interview Preparation

### Common Questions

- "How do you keep a codebase consistent?"
- "What is your Definition of Done?"

### Sample Answers

- **"Consistency?"** — Coding standards, API standards, testing
  strategy, git workflow, Definition of Done. CI guardrails enforce
  the load-bearing rules.
- **"Definition of Done?"** — Tests pass, CI passes, audit rows
  emitted, docs updated, `STATUS.md` updated.

## Related Documents

- [`../README.md`](../README.md) — documentation homepage

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)