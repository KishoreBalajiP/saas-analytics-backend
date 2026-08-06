# Phase 4 — Advanced Enterprise (Future)

> **WHAT this is:** the record of Phase 4 — KMS hardening, multi-region
> active/active, data residency per tenant, custom domains,
> white-label branding.
> **WHY it exists:** Phase 3 introduces the enterprise hooks; Phase 4
> retires the dev-mode fallbacks.
> **HOW to use it:** read *Planned Deliverables*; each item retires a
> Phase 1/2/3 fallback.
> **WHEN to update it:** when a Phase 4 deliverable moves from
> *Future* to *Planned*.
> **WHERE it lives:** `src/docs/phases/phase-4.md`.

---

## Purpose

> **WHAT this is:** the record of Phase 4 — KMS hardening, multi-region,
> data residency, custom domains, white-label.
> **WHY it exists:** Phase 3 introduces enterprise hooks; Phase 4
> retires the dev-mode fallbacks.
> **HOW to use it:** read *Planned Deliverables*; each retires a
> Phase 1/2/3 fallback.
> **WHEN to update it:** when a Phase 4 deliverable moves from
> *Future* to *Planned*.
> **WHERE it lives:** `src/docs/phases/phase-4.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Enterprise architect** | Knows what Phase 4 retires and what it adds. |
| **PM** | Has the dependency map for Phase 3 → Phase 4 sequencing. |

## Current Status

> **Status:** `Future`.
> **Sprint:** No sprint plan exists.
> **Owner:** Engineering team (after Phase 3 closes).

## Business Perspective

Phase 3 is "enterprise procurement passes". Phase 4 is "enterprise
production at scale": KMS is mandatory, multi-region is required,
data residency is contractually binding, custom domains are the
expected UX.

## Planned Deliverables

1. **KMS-managed encryption keys hardened.** Phase 3 swaps in KMS;
   Phase 4 retires the env-key fallback in
   [`utils/encryption.js`](../../../src/utils/encryption.js) for
   production deployments. Envelope becomes `v3: kms-only`.
2. **Multi-region active/active deployment.** Region-aware config
   (`config/region.js`); per-region cache + queue scoping; per-tenant
   `dataRegion` on the `Tenant` model; cross-region read replicas for
   analytics.
3. **Data residency per tenant.** A tenant may be assigned to a
   region; their data never leaves it. `tenantScope` plugin gains a
   `dataRegion` filter on every read.
4. **Custom-domain tenant routing.** `resolveTenant` middleware
   learns to parse `*.saas-analytics.com` subdomains and assign
   tenants accordingly; per-tenant TLS via SNI.
5. **White-label branding.** Per-tenant logo, colour palette, email
   template overrides; `/embed/<token>` returns a wrapper that
   applies the tenant's branding.
6. **Per-tenant connector rate limits.** Each tenant gets a quota;
   `quota` middleware enforces it before the queue.
7. **Dedicated cluster option.** Customers who require isolation
   beyond multi-tenant can be deployed on a dedicated cluster; the
   codebase already supports it via env-driven config.

## Dependencies

Phase 3 complete.

## Completion Criterion

All 7 deliverables ship; the platform is competitive with Looker,
Tableau and Mode in enterprise procurement.

## Expected Outcome

A platform that meets the bar of the most demanding enterprise
customer: KMS-only, multi-region, data-residency compliant, white-label.

## Real-world Examples

- A Fortune 500 RFP asks "do you support data residency?" — Phase 4
  answer: yes, per tenant, with hard isolation.
- A multinational asks "do you support custom domains?" — Phase 4
  answer: yes, with per-tenant branding and TLS.

## Best Practices

| Do | Why |
| --- | --- |
| **Retire dev-mode fallbacks in Phase 4, not Phase 3.** | Phase 3 introduces the hooks; Phase 4 enforces the production use. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Skipping Phase 3.** | Phase 4 retires Phase 3 fallbacks; skipping Phase 3 means no hooks to retire. |

---

## Summary

Phase 4 hardens what Phase 3 introduced. KMS becomes mandatory;
multi-region is active/active; data residency is contractually
binding; custom domains are first-class. The codebase already has
the hooks.

## Key Takeaways

- **Phase 4 retires Phase 3 fallbacks.** The architecture is ready.
- **No sprint plans yet.** Phase 4 opens when Phase 3 closes.

## Interview Preparation

### Common Questions

- "What's the difference between Phase 3 and Phase 4?"
- "Why is multi-region in Phase 4 and not Phase 3?"

### Sample Answers

- **"Phase 3 vs Phase 4?"** — Phase 3 introduces the enterprise
  hooks; Phase 4 retires the dev-mode fallbacks. Phase 3 ships KMS
  alongside the env-key; Phase 4 removes the env-key. Phase 3 ships
  multi-region as opt-in; Phase 4 makes it the default.

- **"Multi-region in Phase 4?"** — Because multi-region is a
  *deployment* change more than a *code* change. The code is ready
  after Phase 3; the production rollout is Phase 4.

### Real-World Examples

- A Fortune 500 RFP lists "KMS-only, multi-region, data residency,
  custom domains". Every row is in the *Planned Deliverables* list.

### Common Mistakes

- Treating Phase 4 as "more Phase 3". It is the *production* form
  of Phase 3.

## Related Documents

- [`phase-3.md`](./phase-3.md) — previous phase
- [`phase-5.md`](./phase-5.md) — next phase

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 4 — Advanced Enterprise (Future)
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)