# Development — Definition of Done

> **WHAT this is:** what "done" means for every PR, every sprint.
> **WHY it exists:** without a definition, "done" is a feeling.
> **HOW to use it:** check every PR against the list.
> **WHEN to update it:** when the bar changes.
> **WHERE it lives:** `src/docs/development/definition-of-done.md`.

---

## Purpose

> **WHAT this is:** the Definition of Done.
> **WHY it exists:** without a definition, "done" is a feeling.
> **HOW to use it:** check every PR against the list.
> **WHEN to update it:** when the bar changes.
> **WHERE it lives:** `src/docs/development/definition-of-done.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Every contributor** | Has the bar. |
| **Reviewer** | Has the checklist. |

## Current Status

> **Status:** `Maintained`.
> **Sprint:** Always.

---

## Per-PR Checklist

A PR is *done* when **all** of the following are true:

- [ ] Tests pass (`npm test`).
- [ ] CI guards pass (`npm run ci:guards`).
- [ ] `npm audit` reports no new high-severity vulnerabilities.
- [ ] New code follows [`coding-standards.md`](./coding-standards.md).
- [ ] New endpoints follow [`api-standards.md`](./api-standards.md).
- [ ] New Mongoose models apply the shared plugin set.
- [ ] New routes mount `authenticate` (or `adminAuth` /
      `optionalAuthenticate`).
- [ ] New env vars are documented in `.env.example` and
      `environment-setup.md`.
- [ ] New behaviour is documented in the matching
      `src/docs/...` file (and cross-referenced from the sprint
      file).
- [ ] `STATUS.md` is updated if a stub was removed or a sprint
      milestone was reached.
- [ ] PR body references the matching `phases/sprint-N.md`.
- [ ] At least one tech-lead review; security review for any PR
      touching auth, RBAC or isolation.

## Per-Sprint Checklist

A sprint is *done* when **all** of the following are true:

- [ ] Every per-PR item holds for every PR in the sprint.
- [ ] The Definition of Done in the matching `phases/sprint-N.md` is
      fully checked.
- [ ] `STATUS.md` *Sprint Log* row is updated.
- [ ] `CHANGELOG.md` has a sprint entry.
- [ ] The matching `phases/sprint-N.md` file's *Current Status*
      moves to `Completed`.
- [ ] A demoable end-to-end scenario exists (for sprints that ship
      user-visible features).

## Per-Phase Checklist

A phase is *done* when the matching `phases/phase-N.md`
*Completion Criterion* is satisfied.

## Best Practices

| Do | Why |
| --- | --- |
| **Run the checklist yourself** before requesting review. | Reviewers do not debug checklist items. |
| **Move the sprint file's status** at the closing PR. | Future contributors see the truth. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Skipping the docs update.** | Docs drift. |
| **Skipping the `STATUS.md` update.** | The daily-read breaks. |

---

## Summary

The Definition of Done is a checklist. Every PR, every sprint,
every phase checks against it. CI enforces the load-bearing items.

## Key Takeaways

- **Tests, CI, audit.**
- **Docs ship with code.**
- **Status updates ship with code.**

## Interview Preparation

### Common Questions

- "What is your Definition of Done?"

### Sample Answers

- **"DoD?"** — Tests pass, CI guards pass, no new audit
  vulnerabilities, coding standards followed, API standards
  followed, plugins applied, auth mounted, env vars documented,
  docs updated, `STATUS.md` updated, PR body references the sprint.

## Related Documents

- [`coding-standards.md`](./coding-standards.md)
- [`api-standards.md`](./api-standards.md)
- [`testing-strategy.md`](./testing-strategy.md)
- [`documentation-rules.md`](./documentation-rules.md)

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)