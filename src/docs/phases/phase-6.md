# Phase 6 — AI / ML Features (Future, exploratory)

> **WHAT this is:** the record of Phase 6 — anomaly detection on metric
> series, smart alert routing, natural-language query interface,
> auto-generated dashboard layouts.
> **WHY it exists:** Phase 2 ships the data plumbing; Phase 6 ships
> the *insights* on top of it.
> **HOW to use it:** read *Planned Deliverables*.
> **WHEN to update it:** when the exploratory status changes.
> **WHERE it lives:** `src/docs/phases/phase-6.md`.

---

## Purpose

> **WHAT this is:** the record of Phase 6 — AI / ML features.
> **WHY it exists:** Phase 2 ships the data plumbing; Phase 6 ships
> the insights on top of it.
> **HOW to use it:** read *Planned Deliverables*.
> **WHEN to update it:** when exploratory status changes.
> **WHERE it lives:** `src/docs/phases/phase-6.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Data science team** | Has the planned surface to start designing. |
| **PM** | Has the exploratory arc to plan against. |

## Current Status

> **Status:** `Future, exploratory`.
> **Owner:** Engineering team (after Phase 2 closes with enough data
> to train on).

## Business Perspective

Once Phase 2 has shipped and customers have built dashboards, the
natural next ask is "the dashboards are great, but can the platform
*find* the insights for me?". Phase 6 is the answer.

## Planned Deliverables (exploratory)

- **Anomaly detection on metric series.** Extends the
  `jobs/anomaly.job.js` stub (currently disabled by default) into a
  real ML pipeline. Reads metric series from analytics; flags
  outliers; emits alerts via the existing `notifications` module.
- **Smart alert routing.** "This alert is similar to three previous
  alerts, suppress." Reduces alert fatigue.
- **Natural-language query interface.** "Show me revenue by region
  last quarter." Translates natural language to a query plan; runs
  the query; returns the result.
- **Auto-generated dashboard layouts.** Given a tenant's data,
  propose a starter dashboard layout. The user edits; the system
  learns.

## Dependencies

Phase 2 has shipped enough data volume to train on; Phase 3 has
shipped push notifications (for alert delivery).

## Completion Criterion

- Each deliverable has accuracy / recall metrics published in the
  docs.
- Each deliverable degrades gracefully when the model is unavailable
  (returns the same response as today).
- Each deliverable is opt-in (per-tenant flag) until the team is
  confident.

## Expected Outcome

The platform becomes self-driving for the most common analytics use
cases: anomaly detection, smart alerts, natural-language queries,
auto-generated dashboards.

## Real-world Examples

- An analyst asks "what changed last week?" The platform's anomaly
  detector highlights a metric that dropped 20 %; the analyst drills
  in.
- A manager asks the chat "show me revenue by region last quarter."
  The platform returns a chart.

## Best Practices

| Do | Why |
| --- | --- |
| **Make every ML feature opt-in.** | Customers must opt in to model evaluation; do not run models on data without consent. |
| **Publish model accuracy.** | Trust requires transparency. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Train on customer data without consent.** | Regulatory risk; trust risk. |

---

## Summary

Phase 6 is the AI / ML arc on top of Phase 2's data plumbing. Every
deliverable is opt-in and publishes accuracy.

## Key Takeaways

- **No sprint plans.** Phase 6 is exploratory.
- **Every ML feature is opt-in.**
- **Model accuracy is published.**

## Interview Preparation

### Common Questions

- "How do you handle customer consent for ML training?"
- "What happens when the model is unavailable?"

### Sample Answers

- **"Consent?"** — Every ML feature is opt-in, per tenant. The
  consent flag is recorded in the audit log. Models never train on
  data without the tenant's explicit opt-in.

- **"Model unavailable?"** — Every ML feature degrades to a
  non-ML fallback. The natural-language query falls back to the
  query-builder UI; the auto-generated dashboard falls back to the
  empty state.

## Related Documents

- [`phase-5.md`](./phase-5.md) — previous phase
- [`phase-7.md`](./phase-7.md) — next phase

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 6 — AI / ML Features (Future, exploratory)
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)