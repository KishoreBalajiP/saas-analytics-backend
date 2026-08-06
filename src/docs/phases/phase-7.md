# Phase 7 — White-label / Multi-operator (Future, exploratory)

> **WHAT this is:** the record of Phase 7 — operator hierarchy,
> per-operator branding and billing, per-tenant isolation across
> operators, connector marketplace.
> **WHY it exists:** the longest-horizon item. The codebase becomes
> a platform for platforms.
> **HOW to use it:** read *Planned Deliverables*.
> **WHEN to update it:** when the exploratory status changes.
> **WHERE it lives:** `src/docs/phases/phase-7.md`.

---

## Purpose

> **WHAT this is:** the record of Phase 7 — white-label /
> multi-operator.
> **WHY it exists:** the longest-horizon item; the codebase becomes a
> platform for platforms.
> **HOW to use it:** read *Planned Deliverables*.
> **WHEN to update it:** when exploratory status changes.
> **WHERE it lives:** `src/docs/phases/phase-7.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Founding architect** | Has the longest-horizon view to plan around. |
| **Partners** | Know the white-label arc exists. |

## Current Status

> **Status:** `Future, exploratory` — no sprint plan, no committed
> timeline.
> **Owner:** Founding architect (long-horizon planning).

## Business Perspective

Phase 7 turns the SaaS Analytics Platform from a single-operator
product into a multi-operator platform. Partners deploy the platform
under their own brand; each operator has their own tenants,
branding, billing and connector marketplace.

## Planned Deliverables (exploratory)

- **Operator hierarchy** — super-admin > operator > tenant. The
  current `super_admin` role becomes the *root operator*; a new
  `operator` role is introduced.
- **Per-operator branding** — per-operator logo, colour palette,
  email templates; per-operator login subdomain.
- **Per-operator billing isolation** — billing scoped to operators;
  the same Stripe account is not shared across operators.
- **Connector marketplace** — operators publish connectors; tenants
  install them; revenue share between operator and connector author.
- **Custom domain per operator** — Phase 4 ships custom domain per
  tenant; Phase 7 ships custom domain per operator.

## Dependencies

Phase 4 (custom domains, data residency).

## Completion Criterion

- Two operators can co-exist on one deployment with zero leakage.
- A partner can deploy the platform under their own brand with no
  code changes.
- Connector marketplace publishes, installs and bills correctly.

## Expected Outcome

The codebase becomes a platform for platforms. Each deployment can
host many operators; each operator has its own tenants and brand.

## Real-world Examples

- A consultancy deploys the platform under their own brand; their
  customers see no "saas-analytics" anywhere except the embed.
- An OEM integrates the platform into their product; the platform
  becomes invisible.

## Best Practices

| Do | Why |
| --- | --- |
| **Treat operator as a first-class scope.** | It is, in every model, a new layer above tenant. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Skipping Phase 4.** | Phase 7 builds on Phase 4's custom-domain work. |

---

## Summary

Phase 7 is the longest-horizon item. The codebase becomes a platform
for platforms.

## Key Takeaways

- **No sprint plans.** Phase 7 is exploratory.
- **Operator is a new scope above tenant.** Every model gains an
  `operatorId` field; every middleware gains an operator check.

## Interview Preparation

### Common Questions

- "What is the longest-horizon item on the roadmap?"

### Sample Answers

- **"Longest-horizon?"** — Phase 7: white-label / multi-operator.
  One deployment hosts many operators; each operator has their own
  tenants, branding and billing.

## Related Documents

- [`phase-6.md`](./phase-6.md) — previous phase

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 7 — White-label / Multi-operator (Future, exploratory)
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)