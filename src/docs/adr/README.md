# ADR — Architecture Decision Records

> **WHAT this is:** the ADR index — one file per architectural
> decision.
> **WHY it exists:** a decision without a record is a decision that
> will be re-made. The ADR is the record.
> **HOW to use it:** open an ADR before challenging a choice; open
> the index before adding a new ADR.
> **WHEN to update it:** when a decision is challenged and superseded
> (mark the old ADR `Superseded by ADR-NNN`); when a new decision
> lands (append a new file).
> **WHERE it lives:** `src/docs/adr/`.

---

## Purpose

> **WHAT this is:** the ADR index.
> **WHY it exists:** a decision without a record is a decision that
> will be re-made.
> **HOW to use it:** open an ADR before challenging a choice.
> **WHEN to update it:** when a decision is challenged and
> superseded.
> **WHERE it lives:** `src/docs/adr/`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Engineer** | Has the rationale. |
| **Interview candidate** | Has the *why* behind the *what*. |

## Current Status

> **Status:** `Maintained` — new ADRs append.
> **Sprint:** Always.

---

## Index

| ADR | Decision |
| --- | --- |
| [ADR-001](./ADR-001-jose-for-jwt.md) | Use `jose` for JWT |
| [ADR-002](./ADR-002-argon2id-for-passwords.md) | Use Argon2id for password hashing |
| [ADR-003](./ADR-003-in-memory-cache-default.md) | In-memory cache default, Redis when `REDIS_URL` is set |
| [ADR-004](./ADR-004-bullmq-for-queues.md) | Use BullMQ for durable queue transport |
| [ADR-005](./ADR-005-s3-storage-abstraction.md) | S3-compatible storage abstraction |
| [ADR-006](./ADR-006-aes-256-gcm-envelope.md) | AES-256-GCM with versioned envelope for at-rest encryption |
| [ADR-007](./ADR-007-shared-mongoose-plugins.md) | Five shared Mongoose plugins |
| [ADR-008](./ADR-008-idempotency-middleware.md) | Idempotency middleware with cached outcomes |
| [ADR-009](./ADR-009-service-wrappers.md) | Service-wrapper abstraction for infrastructure |
| [ADR-010](./ADR-010-ci-guardrails.md) | Five CI guardrails |

---

## ADR Template

Each ADR follows this template:

```markdown
# ADR-NNN: <title>

**Status:** Accepted | Superseded by ADR-MMM | Deprecated
**Date:** YYYY-MM-DD

## Context
What forces are at play? What problem are we solving?

## Decision
What did we choose?

## Consequences
What becomes easier? What becomes harder?
```

---

## Cross-references

- [`../README.md`](../README.md) — documentation homepage
- [`../03-product-roadmap.md`](../03-product-roadmap.md) — phase plan
- [`../DECISIONS.md`](../DECISIONS.md) — original Sprint 0 ADR
  list (kept for the audit trail)

---

## Maintenance Rules

1. **One file per decision.** Never combine two ADRs.
2. **Superseded ADRs stay** with `Superseded by ADR-MMM` status.
3. **Append-only index.** New ADRs go to the bottom.

---

## Summary

Ten ADRs at Sprint 0 close; the index grows as new decisions land.

## Key Takeaways

- **One file per decision.**
- **Superseded ADRs stay.**
- **Append-only.**

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)