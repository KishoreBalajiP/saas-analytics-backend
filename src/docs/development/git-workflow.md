# Development — Git Workflow

> **WHAT this is:** the git workflow — branches, commits, PRs.
> **WHY it exists:** consistent workflow = clean history.
> **HOW to use it:** read before your first commit.
> **WHEN to update it:** when the workflow changes.
> **WHERE it lives:** `src/docs/development/git-workflow.md`.

---

## Purpose

> **WHAT this is:** the git workflow.
> **WHY it exists:** consistent workflow = clean history.
> **HOW to use it:** read before your first commit.
> **WHEN to update it:** when the workflow changes.
> **WHERE it lives:** `src/docs/development/git-workflow.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Every contributor** | Has the workflow. |
| **Tech lead** | Has the checklist. |

## Current Status

> **Status:** `Maintained`.
> **Sprint:** Always.

---

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | the canonical line; every commit is shippable |
| `feat/<sprint>-<area>` | one branch per sprint area; squash-merged |
| `fix/<area>` | hotfix; squash-merged |
| `docs/<area>` | documentation only; squash-merged |

## Commits

- One commit per logical change.
- Imperative subject: `add jwt.sign audience check`.
- Body explains *why*; code explains *what*.

```
feat(sprint-1): add JWT sign and verify with audience

- Use jose for modern JWE/JWS support
- Audience-aware so the same secret serves both portals
- Typed JwtError so the global handler can map to a status code
```

## Pull Requests

- One PR per branch.
- Title: `[sprint-N] <area>: <imperative summary>`.
- Body: scope, deliverables, definition of done, screenshots /
  curl examples.
- Linked to the matching `phases/sprint-N.md` and the matching
  ticket.
- Reviewers: at least one tech lead; security review for any PR
  touching auth, RBAC or isolation.

## Best Practices

| Do | Why |
| --- | --- |
| **Squash-merge** feature branches. | Clean main history. |
| **Reference the sprint file** in the PR body. | Future contributors find the context. |
| **Run `npm run ci:guards`** before requesting review. | Reviewers do not debug CI. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Force-push to `main`.** | `main` is the canonical line; force-push corrupts history. |
| **Merge before CI passes.** | CI is the gate. |

---

## Summary

One branch per area, one commit per logical change, one PR per
branch, squash-merge to `main`. PR body references the sprint.

## Key Takeaways

- **Squash-merge.**
- **Reference the sprint.**
- **CI must pass.**

## Related Documents

- [`definition-of-done.md`](./definition-of-done.md)
- [`testing-strategy.md`](./testing-strategy.md)

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)