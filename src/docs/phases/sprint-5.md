# Sprint 5 — Analytics Engine + Master Data

> **WHAT this is:** the record for Sprint 5 — the tenant-scoped analytics
> query engine over ingested connector rows, plus the platform-wide
> reference-data catalogue.
> **WHY it exists:** Sprint 6 (dashboards) needs a query engine to execute
> widgets against; every later sprint needs the reference catalogue.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-5.md`.

> **Note (re-scope):** the original Sprint 5 plan was "Platform: settings,
> feature flags, notifications" surfaces. Settings + feature flags already
> shipped inside Sprint 3's `/tenants/*` surface (their engine is
> `setting.service.js` / `featureFlag.service.js`); the standalone
> `/settings/*`, `/feature-flags/*`, `/notifications/*`,
> `/email-templates/*` surfaces stayed fail-closed stubs. When the
> dashboards sprint moved forward, Sprint 5 was re-scoped to the
> **Analytics Engine + Master Data** so Sprint 6 could execute widgets.

---

## Purpose

> **WHAT this is:** the record for Sprint 5 — Analytics Engine + Master
> Data.
> **WHY it exists:** ingested connector rows are useless without a query
> engine, and the platform-wide catalogue (countries, currencies, plans,
> …) is needed by every later sprint.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-5.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 6 implementer** | Knows the engine contract dashboards execute against. |
| **Tech lead** | Has the delivered engine + catalogue inventory. |

## Current Status

> **Status:** `Complete` (Sprint 5 closed).
> **Sprint:** Sprint 5 — Analytics Engine + Master Data.
> **Owner:** Engineering team.
> **Verification:** 325 tests total; CI 5/5 green; `npm audit` clean.
> The sprint shipped as re-scoped — every deliverable below is implemented.

## Business Perspective

Customers ingest CSV/webhook data and immediately want to ask questions
of it: "how many rows this month, grouped by region". Sprint 5 ships the
engine that answers those queries, plus the global catalogue every
tenant's forms and dashboards reference.

## Technical Perspective

`analytics.engine.js` compiles a normalised query into a single MongoDB
aggregation over `ConnectorRow` — no row materialisation in Node, so large
connectors paginate cheaply. It ALWAYS injects `tenantId` into the leading
`$match` and excludes soft-deleted rows, because `aggregate()` bypasses
the `tenantScope` query middleware. `analytics.service.js` owns cache
keying + run history. `masterData.service.js` provides a single admin
write surface with a cached public read surface.

## Scope

- `analytics.engine.js` — filters, date presets, sort, pagination,
  projection; `groupBy` + metrics aggregation; non-grouped queries return
  raw connector rows.
- `analytics.service.js` — cached query execution, run history,
  best-effort history persistence.
- `analytics.cache.js` — query cache keyed by `tenantId` + query hash.
- `MasterData` model + `masterData.service.js` — admin write, public
  cached read.
- `/analytics/*` + `/master-data/*` routes (real, authenticated/RBAC or
  public-read).

## Deliverables

### Engine

- `src/services/analytics.engine.js` — `queryRows` / `queryFacet`:
  filter ops `eq, neq, in, nin, gt, gte, lt, lte, exists`; metric ops
  `count, sum, avg, min, max`; `filtersOp` `and`/`or`; `groupBy` turns
  on aggregation (`groupMode: 'grouped'`), otherwise rows are raw
  connector rows (`groupMode: 'raw'`).
- Contract: `{ tenantId, connectorIds?, filters?, filtersOp?, dateRange?,
  metrics?, groupBy?, orderBy?, pagination? }` →
  `{ rows, total, page, pages, limit, columns, executedAt, groupMode }`.

### Service + cache

- `src/services/analytics.service.js` — `query`, `getQuery`,
  `listQueries`, `scheduleExport`.
- `src/services/analytics.cache.js` — cache key + `cachedQuery`.
- `src/services/analytics.scheduler.js` — async export scheduling.
- `src/repositories/analytics.repository.js` — run-history persistence.

### Master Data

- `src/models/MasterData.js` — `category`-discriminated reference items.
- `src/services/masterData.service.js` — admin write, public cached read
  (`master-data:<category>`).
- `src/routes/master-data.routes.js` — `GET /:catalogue` (public,
  cached), `GET /:catalogue/:id`, `POST`/`PATCH`/`DELETE` (admin).

### Routes (real)

- `src/routes/analytics.routes.js` — `GET /`, `GET /queries`,
  `GET /queries/:id`, `POST /export`, behind `authenticate →
  resolveTenant → permission('analytics', …)`.
- `src/routes/master-data.routes.js` — reads public, writes behind
  `adminAuth`.

### Models

- `src/models/AnalyticsQuery.js` — historical run records.
- `src/models/MasterData.js` — reference catalogue items.

## Dependencies

- Sprint 4 (Connector Platform: ingested `ConnectorRow` data the engine
  reads) + Sprint 3 (multi-tenancy: tenant scoping + settings/flags
  engines) + Sprint 0 (cache).

## Testing

- `tests/analytics/analytics.engine.raw.test.js` (2) — non-grouped raw
  reads.
- `tests/analytics/analytics.engine.filters.test.js` (10) — filters, date
  presets, sort, paging.
- `tests/analytics/analytics.engine.aggregations.test.js` (6) — `groupBy`
  + metrics.
- `tests/analytics/analytics.cache.test.js` (3) — query cache hit/miss.
- `tests/analytics/analytics.service.test.js` (6) — service facade +
  history.
- `tests/analytics/analytics.controller.test.js` (5) — route handlers.
- `tests/master-data/masterData.test.js` (8) — catalogue CRUD + cache +
  admin gate.

## Risks

1. **`aggregate()` bypasses Mongoose query middleware.** The engine must
   inject `tenantId` + `deletedAt: null` itself — it does, defensively.
2. **Cache coherency.** Query cache keys include the full query hash +
   `tenantId`, so different queries never collide.

## Definition of Done

- [x] All deliverables merged.
- [x] Analytics engine with filters, date presets, pagination,
      `groupBy` + metrics.
- [x] Cached query execution + run history.
- [x] Master Data catalogue with admin write / public cached read.
- [x] `/analytics/*` + `/master-data/*` routes behind the standard
      middleware chain.
- [x] 40 new tests (325 total).
- [x] `STATUS.md` updated.

## Expected Outcome

Tenants can query their ingested connector rows through a clean read API,
and every form/dashboard can pull its reference catalogue.

## Best Practices

| Do | Why |
| --- | --- |
| **Inject `tenantId` into every aggregation.** | `aggregate()` skips the `tenantScope` plugin. |
| **Hash the whole query into the cache key.** | Two different queries must never share a cached result. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Treating non-grouped queries as aggregated.** | Without `groupBy`, the engine returns raw connector rows, not metrics. |
| **Returning secret-ish config in read surfaces.** | Master-data reads are public; writes stay admin-gated. |

---

## Summary

Sprint 5 delivered the analytics query engine (Sprint 6 executes widgets
against it) and the platform-wide reference catalogue. The original
settings/feature-flags/notifications surface plan was deferred because
the engines already shipped in Sprint 3.

## Key Takeaways

- **The engine runs in MongoDB** — no row materialisation in Node.
- **Aggregation requires `groupBy`** — non-grouped queries return raw rows.
- **Master Data is global** — admin write, public cached read.

## Interview Preparation

### Common Questions

- "How does a tenant query only its own connector rows?"
- "When does the engine aggregate versus return raw rows?"

### Sample Answers

- **"Tenancy?"** — The engine always prepends `tenantId` + `deletedAt:
  null` to the `$match`; `aggregate()` bypasses the `tenantScope`
  middleware, so this is enforced in the engine itself.
- **"Raw vs grouped?"** — Only when `groupBy` is non-empty does the
  engine emit `$group` stages (metrics `sum/avg/count/min/max`).
  Otherwise it returns raw `ConnectorRow`s with the result `total`.

### Real-World Examples

- A tenant syncs 2M CSV rows via Sprint 4, then runs
  `groupBy: [{ field: 'region' }], metrics: [{ op: 'sum', field: 'revenue' }]`.
  The engine returns per-region sums computed in MongoDB, cached under a
  `tenantId` + query-hash key.

### Common Mistakes

- Assuming `aggregate()` inherits tenant scoping from the model plugin.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-4.md`](./sprint-4.md) — previous (Connector Platform)
- [`sprint-6.md`](./sprint-6.md) — next (Dashboards & Widgets)
- [`../backend/connectors.md`](../backend/connectors.md) — data source

## Last Updated

- **Sprint:** Sprint 5 close (Analytics Engine + Master Data)
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-12
- **Author:** Engineering (Sprint 5 close, re-scope from platform surfaces)