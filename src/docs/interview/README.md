# Interview Preparation

> **WHAT this is:** the interview preparation reference for this
> codebase.
> **WHY it exists:** every question a hiring manager asks about
> multi-tenant SaaS, RBAC, queues, JWT, RBAC engines and
> multi-region has a real answer grounded in this code.
> **HOW to use it:** open the topic; read the *Common Questions*;
> rehearse the *Sample Answers*.
> **WHEN to update it:** when the codebase changes an answer.
> **WHERE it lives:** `src/docs/interview/`.

---

## Purpose

> **WHAT this is:** the interview preparation reference.
> **WHY it exists:** every question has a real answer grounded in
> this code.
> **HOW to use it:** open the topic; rehearse the answers.
> **WHEN to update it:** when the codebase changes an answer.
> **WHERE it lives:** `src/docs/interview/`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Candidate** | Has the answers. |
| **Interviewer** | Has the canonical answers to compare against. |

## Current Status

> **Status:** `Maintained`.
> **Sprint:** Always.

---

## Index

The interview prep covers the topics you are most likely to be
asked about. Each topic is grounded in the matching backend
deep-dive; start there before opening the interview notes.

| Topic | Anchor doc |
| --- | --- |
| Authentication (JWT, refresh, MFA) | [`../backend/authentication.md`](../backend/authentication.md) |
| Multi-Tenancy | [`../backend/multi-tenancy.md`](../backend/multi-tenancy.md) |
| RBAC | [`../backend/rbac.md`](../backend/rbac.md) |
| Connectors | [`../backend/connectors.md`](../backend/connectors.md) |
| Queues / BullMQ | [`../backend/queues.md`](../backend/queues.md) |
| Cache / Redis | [`../backend/cache.md`](../backend/cache.md) |
| Storage / S3 | [`../backend/storage.md`](../backend/storage.md) |
| Database / MongoDB | [`../backend/database.md`](../backend/database.md) |
| Security | [`../backend/security.md`](../backend/security.md) |
| Monitoring | [`../backend/monitoring.md`](../backend/monitoring.md) |
| WebSockets | [`../backend/websockets.md`](../backend/websockets.md) |

The cross-cutting interview topics (Node.js, Express, system
design, architecture) are answered in the *Interview Preparation*
section of every backend doc; the per-topic files in this folder
are reserved for deeper rehearsals and will land as those topics
are exercised in interviews.

---

## Cross-references

- [`../README.md`](../README.md) — documentation homepage
- [`../01-getting-started.md`](../01-getting-started.md) — onboarding
- [`../02-project-vision.md`](../02-project-vision.md) — the *why*
- [`../03-product-roadmap.md`](../03-product-roadmap.md) — phases
- [`../04-business-flow.md`](../04-business-flow.md) — end-to-end story
- [`../05-user-journey.md`](../05-user-journey.md) — personas
- [`../backend/`](../backend/) — concern deep-dives
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — system architecture
- [`../DECISIONS.md`](../DECISIONS.md) — ADRs
- [`../adr/`](../adr/) — individual ADRs

---

## Maintenance Rules

1. **Answers are grounded in code.** No aspirational claims.
2. **Examples are real commands / HTTP requests** that can be run.
3. **Cross-references are real links.**

---

## Summary

Every interview question has a real answer grounded in this
codebase. Use this folder to rehearse.

## Key Takeaways

- **Every answer cites code or ADR.**
- **Examples are runnable.**

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)