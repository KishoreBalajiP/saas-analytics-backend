# Phase 5 — Mobile Apps & SDKs (Future, exploratory)

> **WHAT this is:** the record of Phase 5 — native mobile applications
> and official SDKs for the most popular languages.
> **WHY it exists:** Phase 2 ships a web-first product; Phase 3 ships
> enterprise plumbing; Phase 5 is the first product-extension arc.
> **HOW to use it:** read *Planned Deliverables*.
> **WHEN to update it:** when the exploratory status changes.
> **WHERE it lives:** `src/docs/phases/phase-5.md`.

---

## Purpose

> **WHAT this is:** the record of Phase 5 — native mobile apps and
> official SDKs.
> **WHY it exists:** Phase 2 ships a web-first product; Phase 5 is
> the first product-extension arc.
> **HOW to use it:** read *Planned Deliverables*.
> **WHEN to update it:** when exploratory status changes.
> **WHERE it lives:** `src/docs/phases/phase-5.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Mobile team** | Has the planned surface to start designing. |
| **Partners** | Know an SDK is on the roadmap. |

## Current Status

> **Status:** `Future, exploratory` — no sprint plan, no committed
> timeline.
> **Owner:** Engineering team (after Phase 3 closes).

## Business Perspective

The web product is enough for the first 100 customers. Past that,
mobile-first customers ask "where is your iOS app?". Phase 5 is the
answer.

## Planned Deliverables (exploratory)

- **iOS app** — Swift or React Native; login via existing
  `/auth/login` + `/auth/refresh`; dashboard list and viewer; report
  download; notification inbox.
- **Android app** — Kotlin or React Native; same surface.
- **JavaScript SDK** — `@saas-analytics/sdk`; typed wrappers over the
  REST API; framework adapters (React, Vue).
- **Python SDK** — `saas-analytics`; typed wrappers; async client.
- **Go SDK** — `github.com/saas-analytics/saas-analytics-go`; typed
  wrappers; context-aware.
- **Push notifications** (delivery) — Phase 3 ships the platform
  plumbing; Phase 5 ships the iOS / Android client integration.

## Dependencies

Phase 3 complete (push notifications, OAuth).

## Completion Criterion

- iOS and Android apps ship to TestFlight and internal track.
- Each SDK has a working example app and is published to the
  language's package registry.
- The example apps pass the same CI smoke tests as the web product.

## Expected Outcome

The platform is usable from any client, anywhere, with a first-class
mobile experience.

## Real-world Examples

- A mobile-first customer asks "do you have an iOS app?" Phase 5 is
  the answer.

## Best Practices

| Do | Why |
| --- | --- |
| **Re-use the Phase 2 /auth/* surface.** | The web login is the mobile login. Do not build a parallel API. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Building a separate auth API for mobile.** | The JWT auth is the JWT auth. |

---

## Summary

Phase 5 ships mobile apps and SDKs. The web platform is the
backbone; the mobile experience is a thin client.

## Key Takeaways

- **No sprint plans.** Phase 5 is exploratory.
- **Re-use the web API.** Mobile is a client, not a parallel
  product.

## Interview Preparation

### Common Questions

- "Why is mobile a separate phase?"
- "Will the mobile app have a different feature set?"

### Sample Answers

- **"Why separate?"** — Because the *team* is different. Web and
  mobile have different release cadences, different review
  processes, different platforms. Phase 5 acknowledges that.

- **"Different feature set?"** — No. Mobile is a *client* of the
  same backend; the API surface is the API surface. Mobile may
  lead with notification inbox and report viewer, but the API is
  identical.

## Related Documents

- [`phase-4.md`](./phase-4.md) — previous phase
- [`phase-6.md`](./phase-6.md) — next phase

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 5 — Mobile Apps & SDKs (Future, exploratory)
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)