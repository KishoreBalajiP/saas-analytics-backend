# Phase 1.2 — Platform Management Architecture

> **WHAT this is:** the record of Phase 1.2 — the fail-closed route
> shells and middleware stubs every later sprint fills in.
> **WHY it exists:** without fail-closed stubs, an unfinished
> endpoint can silently allow traffic. Phase 1.2 closes every door
> that Phase 2 will eventually open.
> **HOW to use it:** read *Deliverables* and *Completion Criterion*.
> **WHEN to update it:** only if a Phase 1.2 file changes.
> **WHERE it lives:** `src/docs/phases/phase-1.2.md`.

---

## Purpose

> **WHAT this is:** the record of Phase 1.2 — the fail-closed route
> shells and middleware stubs.
> **WHY it exists:** without fail-closed stubs, an unfinished endpoint
> can silently allow traffic; without fail-closed middleware, an
> unfinished auth check can let unauthorised requests through.
> **HOW to use it:** read *Deliverables* and *Completion Criterion*.
> **WHEN to update it:** only if a Phase 1.2 file changes.
> **WHERE it lives:** `src/docs/phases/phase-1.2.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **New backend engineer** | Knows every future endpoint has a stub. |
| **Sprint implementer** | Has a mount point to attach handlers to. |
| **Security reviewer** | Knows no unfinished surface is open. |

## Current Status

> **Status:** `Completed`.
> **Sprint:** Completed before Sprint 0; every planned route returns
> `501` with a `hint` pointing at the owning module README.
> **Owner:** Founding architect.

## Business Perspective

When a customer hits `/api/v1/auth/login` today, they get a 501 with
a `hint` that points at the Sprint 1 module README. They do not get
a 200 with a fake response; they do not get a 500. The platform
honestly says "this is not built yet".

## Technical Perspective

Every route shell returns:

```js
res.status(501).json({
  success: false,
  statusCode: 501,
  message: '<OP> is not implemented yet (Phase 2 - Sprint N)',
  hint: 'See src/modules/<feature>/README.md',
});
```

Every middleware stub returns `ApiError.notImplemented(...)`. The CI
guards `check-routes` and `check-stubs` enforce the discipline.

## Deliverables

| Area | Files |
| --- | --- |
| Route shells | every `src/routes/*.routes.js` (currently `admin-auth`, `admin`, `audit-log`, `auth`, `connector`, `dashboard`, `email-template`, `embed`, `feature-flag`, `master-data`, `monitoring`, `notification`, `permission`, `report`, `role`, `settings`, `support`, `tenant`, `user`, `webhook`) |
| Middleware stubs | `adminAuth`, `audit`, `compliance`, `modulePermission`, `permission`, `rbac`, `tenant`, `tenantIsolation` |
| Module folders | every folder under `src/modules/<feature>/` with a README + STATUS.md |
| Module service / repository / controller / model stubs | per the conventions in their READMEs |

## Dependencies

Phase 1 + Phase 1.1.

## Completion Criterion

```bash
curl -i http://localhost:8080/api/v1/auth/login -X POST -d '{}' -H 'Content-Type: application/json'
# → 501; body contains "hint":"See src/modules/iam/auth/README.md"
curl -i http://localhost:8080/api/v1/does-not-exist
# → 404 with the standard error envelope
npm run ci:guards
# → 5 / 5 OK
```

## Expected Outcome

A complete *route skeleton* any future sprint fills in without
touching `app.js`, `server.js` or the route mounting logic.

## Real-world Examples

- Sprint 1 opens the `/auth/login` route, removes the `501`
  placeholder, mounts `authenticate` middleware, and ships a real
  login endpoint.
- A reviewer sees a new route in a PR. They run `npm run ci:guards`;
  if the route is mounted without auth, `check-routes` blocks the
  PR.

## Best Practices

| Do | Why |
| --- | --- |
| **Keep the `hint` pointing at the module README.** | The hint is the bridge from the API surface to the documentation. |
| **Treat the fail-closed discipline as load-bearing.** | Silently letting traffic through an unfinished check is a security incident. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Returning 200 with a placeholder body.** | A frontend cannot tell the difference and will integrate against the placeholder. |
| **Mounting a new route without auth.** | `check-routes` will block the PR; do not bypass the guard. |

---

## Summary

Phase 1.2 ships every planned route shell and middleware stub as
fail-closed `501`. CI guardrails enforce the discipline. Sprint 1–9
fill in the shells one by one without changing the boot path or the
mounting logic.

## Key Takeaways

- **Every planned endpoint exists today as a 501 stub.** The
  skeleton is complete; the body fills in over Sprints 1–9.
- **The `hint` field is part of the contract.** It tells the client
  where the implementation will live.
- **Two CI guards enforce the discipline.** `check-routes` blocks
  unauthenticated routes; `check-stubs` blocks orphan stubs.

## Interview Preparation

### Common Questions

- "Why does every endpoint return 501 instead of a placeholder?"
- "What stops a contributor from accidentally letting traffic
  through an unfinished auth check?"

### Sample Answers

- **"Why 501?"** — Because a placeholder 200 teaches a frontend to
  depend on something that does not exist. A 501 with a hint is
  honest, fail-closed, and points the reader at the documentation
  that explains when the real implementation ships.

- **"What stops the leak?"** — Two CI guards. `check-routes` fails
  any real route handler mounted without `authenticate`,
  `adminAuth` or `optionalAuthenticate` (or an explicit
  `ci:routes-exempt` annotation). `check-stubs` fails any
  `notImplementedStub` outside the allowlist. Together they make
  "silently let traffic through an unfinished check" impossible.

### Real-World Examples

- A reviewer runs `npm run ci:guards` on a PR that adds a new route.
  `check-routes` fails; the contributor adds `authenticate`; the PR
  merges.
- A customer hits `/api/v1/auth/login` today. They get a 501 with
  the hint. They do not get a 200 with a fake token. The platform
  is honest.

### Common Mistakes

- Treating 501 stubs as "almost done". They are deliberately
  fail-closed; turning one into a 200 is the Sprint's job, not
  something to do in passing.

## Related Documents

- [`../README.md`](../README.md) — documentation homepage
- [`../03-product-roadmap.md`](../03-product-roadmap.md) — phase-by-phase plan
- [`phase-1.md`](./phase-1.md) — previous phase
- [`phase-2.md`](./phase-2.md) — next phase
- [`../../modules/`](../../modules/) — every module folder

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 1.2 — Platform Management Architecture
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)