# Sprint 0 — Shared Implementation Foundation

> **WHAT this is:** the record of Sprint 0 — the shared implementation
> foundation every other sprint depends on.
> **WHY it exists:** Sprint 0 is the bridge between Phase 1 (contracts)
> and Phase 2 (features). Documenting what shipped, what was
> deliberately deferred and what tests cover is the difference
> between a foundation and a black box.
> **HOW to use it:** read *Deliverables* and *Test Coverage*.
> **WHEN to update it:** only if a Sprint 0 file changes.
> **WHERE it lives:** `src/docs/phases/sprint-0.md`.

---

## Purpose

> **WHAT this is:** the record of Sprint 0 — the shared implementation
> foundation.
> **WHY it exists:** Sprint 0 is the bridge between Phase 1 and
> Phase 2; documenting what shipped keeps every later sprint honest.
> **HOW to use it:** read *Deliverables* and *Test Coverage*.
> **WHEN to update it:** only if a Sprint 0 file changes.
> **WHERE it lives:** `src/docs/phases/sprint-0.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 1+ implementer** | Has the foundation list to import from. |
| **Tech lead** | Has the test inventory to plan capacity. |

## Current Status

> **Status:** `Completed`.
> **Sprint:** Sprint 0.
> **Owner:** Engineering team.

## Business Perspective

Sprint 0 is invisible to the customer (no business feature ships)
but mandatory for the team. Every later sprint writes code against
the surface Sprint 0 shipped.

## Technical Perspective

Sprint 0 fills in the Phase 1 contracts with real implementations
and adds the shared Mongoose plugin set, the idempotency middleware
and the CI guardrails.

## Scope (MVP)

Production-ready utilities, real cache / queue / storage / email
drivers, the shared Mongoose plugin set, idempotency middleware and
CI guardrails. No business logic.

## Deliverables

### Utilities
- [`src/utils/jwt.js`](../../../src/utils/jwt.js) — `jose`-based JWT, audience + issuer aware
- [`src/utils/password.js`](../../../src/utils/password.js) — Argon2id
- [`src/utils/id.js`](../../../src/utils/id.js) — UUIDv4 + monotonic ULID + prefixed IDs
- [`src/utils/encryption.js`](../../../src/utils/encryption.js) — AES-256-GCM envelope
- [`src/utils/idempotency.js`](../../../src/utils/idempotency.js) — deterministic SHA-256 key

### Cache layer
- [`src/cache/memory.js`](../../../src/cache/memory.js), [`src/cache/redis.js`](../../../src/cache/redis.js) — drivers
- [`src/services/cache.service.js`](../../../src/services/cache.service.js) — public interface

### Queue layer
- [`src/queues/memory.queue.js`](../../../src/queues/memory.queue.js) — in-memory transport
- [`src/queues/index.js`](../../../src/queues/index.js) — BullMQ transport selector
- [`src/queues/{connector,email,analytics}.queue.js`](../../../src/queues/) — per-queue contracts
- [`src/services/queue.service.js`](../../../src/services/queue.service.js) — public interface

### Storage layer
- [`src/storage/localStorage.js`](../../../src/storage/localStorage.js), [`src/storage/s3Storage.js`](../../../src/storage/s3Storage.js)
- [`src/services/storage.service.js`](../../../src/services/storage.service.js) — public interface

### Email layer
- [`src/services/mail.transport.js`](../../../src/services/mail.transport.js) — SMTP/noop factory
- [`src/services/email.service.js`](../../../src/services/email.service.js) — public interface

### Mongoose plugins
- [`src/models/plugins/`](../../../src/models/plugins/) — `tenantScope`, `softDelete`, `paginate`, `optimisticConcurrency`, `audit`

### Middleware
- [`src/middleware/idempotency.middleware.js`](../../../src/middleware/idempotency.middleware.js)
- [`src/middleware/auth.middleware.js`](../../../src/middleware/auth.middleware.js) — unified to `ApiError.notImplemented()`
- [`src/routes/auth.routes.js`](../../../src/routes/auth.routes.js) — unified to stubbed-with-hint pattern

### CI guardrails
- [`scripts/ci/`](../../scripts/ci/) — `check-stubs`, `check-routes`, `check-models`, `check-config`, `check-readme-sync`

### Documentation
- [`src/docs/STATUS.md`](../STATUS.md) updated with *Current Development* section
- [`src/docs/TEMPLATE.md`](../TEMPLATE.md) — the documentation standard

## Dependencies

None — Sprint 0 is the foundation.

## Test Coverage

| File | Tests |
| --- | --- |
| `tests/utils/jwt.test.js` | 11 |
| `tests/utils/password.test.js` | 7 |
| `tests/utils/id.test.js` | 9 |
| `tests/utils/encryption.test.js` | 7 |
| `tests/utils/idempotency.test.js` | 7 |
| `tests/cache/memory.test.js` | 8 |
| `tests/queues/memory.test.js` | 5 |
| `tests/storage/local.test.js` | 6 |
| `tests/services/email.test.js` | 3 |
| `tests/models/plugins.test.js` | 8 |
| `tests/health.test.js` (existing) | 2 |
| **Total** | **73** |

## Risks (carried into Sprint 1)

1. **JWT secret reused for AES.** Mitigated in Sprint 0 by adding a
   separate `ENCRYPTION_KEY` env; rotation is a Phase 3 item.
2. **Webhook signature verification** is a Sprint 6 concern; Sprint 0
   ships the storage + queue seams so the webhook handler can plug
   in.
3. **Idempotency middleware is fail-closed.** If the cache layer is
   down, the request is rejected. Acceptable for mutations; reads
   can opt in to `failOpen: true` per route.

## Definition of Done — all met

- [x] All deliverables merged.
- [x] `npm test` — 73 pass, 0 fail.
- [x] `npm run ci:guards` — 5 / 5 OK.
- [x] `npm audit` — 0 vulnerabilities.
- [x] `npm run dev` boots; `/api/v1/health` returns 200; `/api/v1/auth/login` returns 501 with `hint`.
- [x] `STATUS.md` updated.

## Expected Outcome

A production-grade foundation. Every later sprint writes code against
the surface Sprint 0 shipped; no later sprint re-implements
encryption, JWT, password hashing, cache, queue or storage.

## Real-world Examples

A Sprint 1 engineer opens `src/services/email.service.js` to send the
password-reset email, calls `email.send(...)`, and never imports
`nodemailer`. The seam is invisible to them; Sprint 0 made that
possible.

## Best Practices

| Do | Why |
| --- | --- |
| **Treat the Sprint 0 surface as the only public API.** | Feature code never reaches past `services/`. |
| **Run `npm run ci:guards` on every PR.** | The guards are the only thing that keeps the surface clean. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Importing `ioredis` / `bullmq` / `@aws-sdk/*` / `nodemailer` from feature code.** | The CI guards catch it; the rule exists because provider switching is a one-file change. |

---

## Summary

Sprint 0 ships the shared implementation foundation. 73 tests pass,
5 / 5 CI guards green, 0 vulnerabilities. Every later sprint consumes
the surface Sprint 0 shipped.

## Key Takeaways

- **Sprint 0 is the bridge between Phase 1 and Phase 2.** Phase 1
  shipped contracts; Sprint 0 shipped implementations.
- **Service wrappers are the only public API.** Cache, queue,
  storage, email — never imported directly from feature code.
- **73 tests, 5 guards, 0 vulns.** The Definition of Done.

## Interview Preparation

### Common Questions

- "What did Sprint 0 ship?"
- "Why is Sprint 0 the only sprint that ships infrastructure only?"

### Sample Answers

- **"What shipped?"** — Five production utilities (jwt, password,
  encryption, id, idempotency); real cache, queue, storage and email
  drivers with service wrappers; the shared Mongoose plugin set
  (tenantScope, softDelete, paginate, optimisticConcurrency, audit);
  the idempotency middleware; five CI guardrails; and 73 tests.

- **"Why infrastructure only?"** — Because every other sprint
  assumes this surface. Sprint 1 needs JWT + email + idempotency;
  Sprint 2 needs tenantScope; Sprint 3 needs optimisticConcurrency +
  audit; Sprint 6 needs storage + queue; Sprint 8 needs audit +
  access-log hooks (originally Sprint 7, re-scoped — see
  [`sprint-7.md`](./sprint-7.md)). Building them mid-feature is a
  recipe for shortcuts.

### Real-World Examples

- Sprint 1 imports `services/jwt.service.js`, `services/email.service.js`,
  `services/cache.service.js` and never reaches past them. Sprint 0
  made that possible.

### Common Mistakes

- Re-implementing any Sprint 0 utility in a later sprint. The
  surface is the surface.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase containing this sprint
- [`sprint-1.md`](./sprint-1.md) — next sprint
- [`../STATUS.md`](../STATUS.md) — daily-read project state
- [`../TEMPLATE.md`](../TEMPLATE.md) — documentation standard

## Last Updated

- **Sprint:** Sprint 0
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)