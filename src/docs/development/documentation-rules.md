# Development — Documentation Rules

> **WHAT this is:** the rules that keep documentation in sync with
> code.
> **WHY it exists:** documentation that drifts is worse than no
> documentation.
> **HOW to use it:** apply every rule when you change code that
> affects any doc.
> **WHEN to update it:** when a rule changes.
> **WHERE it lives:** `src/docs/development/documentation-rules.md`.

---

## Purpose

> **WHAT this is:** the documentation rules.
> **WHY it exists:** documentation that drifts is worse than no
> documentation.
> **HOW to use it:** apply every rule when you change code.
> **WHEN to update it:** when a rule changes.
> **WHERE it lives:** `src/docs/development/documentation-rules.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Every contributor** | Has the rules. |
| **Reviewer** | Has the checklist. |

## Current Status

> **Status:** `Maintained`.
> **Sprint:** Always.

---

## The Five Rules

1. **Documentation changes ship with the code that makes them
   true.** A PR that changes behaviour without updating docs is
   incomplete.
2. **Cross-references are real links.** Renaming a file means
   fixing every link to it in the same commit.
3. **Diagrams are ASCII-first.** They render in every terminal,
   every IDE, every GitHub view.
4. **Examples must run.** No pseudocode masquerading as code.
5. **Every new document follows [`../TEMPLATE.md`](../TEMPLATE.md).**
   The 15-section structure is mandatory.

## Per-Doc Maintenance

- **`STATUS.md`** — updated at every sprint closure.
- **`CHANGELOG.md`** — updated at every sprint closure.
- **Per-area docs** (`backend/`, `architecture/`, `phases/`) —
  updated when the area changes.
- **Per-module READMEs** (`src/modules/<feature>/README.md`) —
  updated when the module's contract changes.
- **Per-module `STATUS.md`** — updated when the module's
  implementation status changes.

## Best Practices

| Do | Why |
| --- | --- |
| **Cross-link every doc** that touches the topic. | Readers follow the chain. |
| **Use the same vocabulary** across docs and code. | Consistency. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Skipping the doc update** because "the code is self-explanatory". | Code explains *what*; docs explain *why*. |
| **Inventing architecture** to make a doc prettier. | Docs reflect the code, not aspirations. |

---

## Summary

Five rules. The CI guards enforce the structural ones; reviewers
enforce the content ones. Documentation that drifts is worse than
no documentation.

## Key Takeaways

- **Docs ship with code.**
- **Examples must run.**
- **TEMPLATE.md is mandatory.**

## Interview Preparation

### Common Questions

- "How do you keep documentation in sync with code?"

### Sample Answers

- **"In sync?"** — Every PR that changes behaviour updates the
  matching doc in the same commit. CI guard `check-readme-sync`
  enforces the existence of root docs and per-module `STATUS.md`.
  `npm run ci:guards` is part of the Definition of Done.

## Related Documents

- [`definition-of-done.md`](./definition-of-done.md)
- [`../TEMPLATE.md`](../TEMPLATE.md) — documentation standard
- [`../README.md`](../README.md) — documentation homepage

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)