# Development — Testing Strategy

> **WHAT this is:** the testing strategy — what we test, how we test,
> what we never test.
> **WHY it exists:** tests are the safety net for every change.
> **HOW to use it:** read before writing the first test of a sprint.
> **WHEN to update it:** when the strategy changes.
> **WHERE it lives:** `src/docs/development/testing-strategy.md`.

---

## Purpose

> **WHAT this is:** the testing strategy.
> **WHY it exists:** tests are the safety net.
> **HOW to use it:** read before writing the first test of a sprint.
> **WHEN to update it:** when the strategy changes.
> **WHERE it lives:** `src/docs/development/testing-strategy.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Every contributor** | Has the test plan. |
| **Reviewer** | Has the coverage checklist. |

## Current Status

> **Status:** `Maintained`.
> **Sprint:** Always.
> **Owner:** Engineering team.

---

## Test Layers

| Layer | Lives | Tooling |
| --- | --- | --- |
| Unit | next to source (`<name>.test.js`) | `node --test` |
| Integration | `tests/integration/` (planned Sprint 1+) | `node --test` + `mongodb-memory-server` |
| Smoke | `tests/health.test.js` (existing) | `node --test` |
| CI guard | `scripts/ci/` | plain Node scripts |

## What We Test

- Every utility (`utils/jwt.js`, `utils/password.js`, etc.) has
  unit tests for the happy path + every error path.
- Every driver (`cache/memory.js`, `storage/localStorage.js`,
  `queues/memory.queue.js`) has unit tests for the public surface.
- Every Mongoose plugin has integration tests against
  `mongodb-memory-server`.
- Every service wrapper has unit tests for the typed-error mapping.
- Every CI guard script has a manual run that proves it fails on a
  bad input.

## What We Do Not Test

- We do not test the framework (Express, Mongoose, Pino, jose,
  argon2). We trust them.
- We do not test the OS, the network, or the database binary.
- We do not test generated code (OpenAPI clients, ORM models
  generated from a schema, etc.) — we trust the generator.

## Coverage Targets

- Sprint 0 utility / driver / plugin layer: **90 %+**.
- Sprint 1+ business endpoints: **90 %+** for the touched surfaces.
- Critical paths (auth, RBAC, isolation): **100 %** for the
  failure modes.

## Test Hygiene

- Tests are deterministic — no real network, no real clock.
- Use `mongodb-memory-server` for integration tests; do not require
  a running MongoDB.
- Use the `tests/helpers/` factory for fixtures.
- Run `npm test` locally before pushing.

## Best Practices

| Do | Why |
| --- | --- |
| **Test failure modes**, not just happy paths. | The CI guard catches drift; the test catches regressions. |
| **Use the `tests/helpers/` factories.** | Drift-free fixtures. |
| **Run `npm test` locally** before pushing. | The CI is the same check. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Mocking the wrong layer.** | Mock at the boundary (HTTP, queue), not deep inside. |
| **Skipping tests on "trivial" code.** | Trivial code has trivial bugs. |

---

## Summary

The testing strategy is: unit tests next to source, integration
tests against `mongodb-memory-server`, smoke tests for `/health`,
CI guards for architectural rules. 90 %+ coverage target on the
touched surfaces.

## Key Takeaways

- **Test failure modes.**
- **Use the factories.**
- **CI guards cover the architecture; tests cover the code.**

## Interview Preparation

### Common Questions

- "What is your test strategy?"
- "What do you not test?"

### Sample Answers

- **"Strategy?"** — Unit tests next to source; integration tests
  against `mongodb-memory-server`; smoke tests for the health
  surface; CI guards for architecture. 90 %+ on touched surfaces.
- **"What not?"** — Framework, OS, network, generated code. Trust
  the upstream.

## Related Documents

- [`coding-standards.md`](./coding-standards.md)
- [`definition-of-done.md`](./definition-of-done.md)
- [`../../tests/helpers/`](../../tests/helpers/) — factories

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)