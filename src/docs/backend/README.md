# backend/ — Backend Reference

> **WHAT this is:** the backend concern-by-concern reference.
> **WHY it exists:** every Sprint implementer needs a deep-dive
> document for the area they are working on. Phase 2 ships ten of
> them.
> **HOW to use it:** open the document for the area your sprint
> touches; read the *Architecture* and *Real-world Examples*
> sections.
> **WHEN to update it:** as the area changes (the PR updates the
> matching doc).
> **WHERE it lives:** `src/docs/backend/`.

---

## Purpose

> **WHAT this is:** the backend concern-by-concern reference.
> **WHY it exists:** every Sprint implementer needs a deep-dive for
> their area.
> **HOW to use it:** open the document for the area your sprint
> touches.
> **WHEN to update it:** as the area changes.
> **WHERE it lives:** `src/docs/backend/`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint implementer** | Has the deep-dive for their area. |
| **Tech lead** | Has the cross-cutting reference. |

## Current Status

> **Status:** `In Progress` — every area below has a stub doc; deep
> content lands as Sprint 1+ close.
> **Sprint:** Sprint 0 (foundation) is complete; per-area docs fill
> in as Sprints 1–9 close.
> **Owner:** Engineering team.

---

## Index

| Document | Area | Owning Sprint |
| --- | --- | --- |
| [`authentication.md`](./authentication.md) | JWT, sessions, MFA, refresh-token rotation | Sprint 1 |
| [`rbac.md`](./rbac.md) | Roles, permissions, modules, cache | Sprint 3 |
| [`multi-tenancy.md`](./multi-tenancy.md) | Tenant resolution, isolation, scoping | Sprints 1–2 |
| [`connectors.md`](./connectors.md) | BaseConnector framework + concrete providers | Sprint 6 |
| [`queues.md`](./queues.md) | BullMQ + in-memory transport | Sprint 0 (driver); consumers land across sprints |
| [`cache.md`](./cache.md) | Memory + Redis provider | Sprint 0 (driver) |
| [`storage.md`](./storage.md) | Local + S3 provider | Sprint 0 (driver) |
| [`database.md`](./database.md) | MongoDB + Mongoose conventions | Always |
| [`security.md`](./security.md) | Threat model + controls | Always |
| [`monitoring.md`](./monitoring.md) | Health probes + observability | Sprint 8 |
| [`websockets.md`](./websockets.md) | Socket.IO room model | Always |

---

## Cross-references

- [`../README.md`](../README.md) — documentation homepage
- [`../STATUS.md`](../STATUS.md) — daily-read project state
- [`../03-product-roadmap.md`](../03-product-roadmap.md) — phase-by-phase plan
- [`../04-business-flow.md`](../04-business-flow.md) — end-to-end story
- [`../phases/`](../phases/README.md) — sprint index
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — system architecture
- [`../DECISIONS.md`](../DECISIONS.md) — architectural decisions

---

## Maintenance Rules

1. **Per-area doc updates ship with the matching Sprint closure PR.**
2. **Cross-references are real links.** Renaming a file means
   fixing every link to it.

---

## Summary

This folder holds the backend concern-by-concern reference. Every
area has a doc; the docs fill in as sprints close.

## Key Takeaways

- **One doc per concern**, owned by the sprint that ships it.
- **Sprint 0 drivers** (cache, queue, storage, mail) are already
  documented; their consumers land across sprints.

## Interview Preparation

### Common Questions

- "Where do I look up how the cache layer works?"
- "Where do I look up how RBAC is enforced?"

### Sample Answers

- **"Cache?"** — [`backend/cache.md`](./cache.md). Driver surface,
  provider selection, public service wrapper.
- **"RBAC?"** — [`backend/rbac.md`](./rbac.md). Permission key shape,
  cache strategy, middleware usage.

## Related Documents

- [`../README.md`](../README.md) — documentation homepage
- [`../phases/`](../phases/README.md) — sprint index

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)