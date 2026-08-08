# Sprint 6 — Master Data

> **WHAT this is:** the plan for Sprint 6 — the platform-wide catalogue
> (countries, currencies, timezones, plans, languages).
> **WHY it exists:** every later sprint needs a list of countries,
> currencies, plans. Sprint 6 ships the canonical catalogue.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-6.md`.

> **Note (re-scope):** Sprint 6 was originally Connectors (CSV +
> Webhook). The Connector Platform moved up to [Sprint 4](./sprint-4.md)
> (user prioritisation); Master Data moves here.

---

## Purpose

> **WHAT this is:** the plan for Sprint 6 — Master Data.
> **WHY it exists:** every later sprint needs countries, currencies,
> plans. Sprint 6 ships the canonical catalogue.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-6.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 6 implementer** | Has the full plan. |
| **PM** | Has the catalogue categories to validate. |

## Current Status

> **Status:** `Planned`.
> **Sprint:** Sprint 6.
> **Owner:** Engineering team.

## Business Perspective

A SaaS analytics platform must support every country, currency and
timezone a customer can be in. Sprint 6 ships the catalogue that
Sprint 7 (governance) and Sprint 9 (analytics) consume.

## Technical Perspective

A single `MasterDataItem` collection with a `category` discriminator.
Admin write surface; tenant read surface cached at
`master-data:<category>`.

## Scope

- Categories in MVP: `country`, `currency`, `timezone`, `plan`,
  `language`.
- CRUD with optimistic concurrency via `__v`.
- Admin write; tenant read.
- CSV import uses the CSV connector (Sprint 4) manually for MVP.

## Deliverables

### Model
- `src/models/MasterDataItem.js`

### Services
- `src/modules/platform/master-data/master-data.service.js`

### Routes
- `src/routes/master-data.routes.js`

### Seeders
- `src/db/seeds/countries.seed.js` — ISO 3166
- `src/db/seeds/currencies.seed.js` — ISO 4217
- `src/db/seeds/timezones.seed.js` — IANA
- `src/db/seeds/plans.seed.js` — Free, Growth, Enterprise
- `src/db/seeds/languages.seed.js` — en, es, de, fr, ja

## Dependencies

- Sprint 2 (RBAC for the admin write surface).

## Testing

- Unit: optimistic concurrency (version conflict rejected).
- Integration: admin writes a country; tenant reads it; cache hit on
  the second read.

## Risks

1. **Master data is global, not tenant-scoped.** Do not apply
   `tenantScope` to the model.
2. **CSV import** is deferred; manual entry in MVP (CSV connector from
   Sprint 4 can bulk-load).

## Definition of Done

- [ ] All deliverables merged.
- [ ] 250 countries, 180 currencies, 400 timezones, 3 plans, 5
      languages seeded.
- [ ] Admin can add a country; tenant reads it.
- [ ] Optimistic concurrency works (concurrent write rejected).
- [ ] 90 %+ test coverage.
- [ ] `STATUS.md` updated.

## Expected Outcome

Every later sprint has a canonical catalogue to consume.

## Best Practices

| Do | Why |
| --- | --- |
| **Seed from ISO / IANA standards.** | Do not invent country codes. |
| **Cache aggressively.** | Master data is read on every settings page. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Applying `tenantScope` to master data.** | Master data is global. |

---

## Summary

Sprint 6 ships the platform-wide catalogue. After Sprint 6 every later
sprint has countries, currencies, plans to consume.

## Key Takeaways

- **Master data is global**, not tenant-scoped.
- **Seeded from ISO / IANA standards.**
- **CSV import** via the Sprint 4 CSV connector.

## Interview Preparation

### Common Questions

- "Where do master-data lists live?"
- "Why is master data global?"

### Sample Answers

- **"Where?"** — `master-data:<category>` in the cache, written by
  Admin Portal, read by Tenant Portal.
- **"Why global?"** — Because countries do not change per tenant.
  Per-tenant master data is `Setting` (Sprint 3/5), not
  `MasterDataItem`.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-5.md`](./sprint-5.md) — previous
- [`sprint-7.md`](./sprint-7.md) — next
- [`../backend/connectors.md`](../backend/connectors.md) — CSV
  connector used for bulk import

## Last Updated

- **Sprint:** Sprint 6 planned (Master Data)
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-08
- **Author:** Engineering (Sprint 4 re-scope)
