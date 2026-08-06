# Sprint 4 — Master Data

> **WHAT this is:** the plan for Sprint 4 — the platform-wide catalogue
> (countries, currencies, timezones, plans, languages).
> **WHY it exists:** every later sprint needs a list of countries,
> currencies, plans. Sprint 4 ships the canonical catalogue.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-4.md`.

---

## Purpose

> **WHAT this is:** the plan for Sprint 4 — Master Data.
> **WHY it exists:** every later sprint needs countries, currencies,
> plans. Sprint 4 ships the canonical catalogue.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-4.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 4 implementer** | Has the full plan. |
| **PM** | Has the catalogue categories to validate. |

## Current Status

> **Status:** `Planned`.
> **Sprint:** Sprint 4.
> **Owner:** Engineering team.

## Business Perspective

A SaaS analytics platform must support every country, currency and
timezone a customer can be in. Sprint 4 ships the catalogue that
Sprint 5 (settings), Sprint 6 (connectors), and Sprint 9 (analytics)
consume.

## Technical Perspective

A single `MasterDataItem` collection with a `category` discriminator.
Admin write surface; tenant read surface cached at
`master-data:<category>`.

## Scope

- Categories in MVP: `country`, `currency`, `timezone`, `plan`,
  `language`.
- CRUD with optimistic concurrency via `__v`.
- Admin write; tenant read.
- CSV import deferred to Phase 3 (use connector CSV manually for
  MVP).

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

- Sprint 3 (RBAC for the admin write surface).

## Testing

- Unit: optimistic concurrency (version conflict rejected).
- Integration: admin writes a country; tenant reads it; cache hit on
  the second read.

## Risks

1. **Master data is global, not tenant-scoped.** Do not apply
   `tenantScope` to the model.
2. **CSV import** is deferred; manual entry only in MVP.

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

Sprint 4 ships the platform-wide catalogue. After Sprint 4 every
later sprint has countries, currencies, plans to consume.

## Key Takeaways

- **Master data is global**, not tenant-scoped.
- **Seeded from ISO / IANA standards.**
- **CSV import is deferred to Phase 3.**

## Interview Preparation

### Common Questions

- "Where do master-data lists live?"
- "Why is master data global?"

### Sample Answers

- **"Where?"** — `master-data:<category>` in the cache, written by
  Admin Portal, read by Tenant Portal.
- **"Why global?"** — Because countries do not change per tenant.
  Per-tenant master data is `Setting` (Sprint 5), not
  `MasterDataItem`.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-3.md`](./sprint-3.md) — previous
- [`sprint-5.md`](./sprint-5.md) — next

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Sprint planned:** Sprint 4
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)