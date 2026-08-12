# Sprint 6 — Dashboards & Widgets

> **WHAT this is:** the record for Sprint 6 — tenant-scoped dashboard +
> widget authoring and widget analytics execution over the analytics
> engine.
> **WHY it exists:** Sprint 5 shipped the query engine; Sprint 6 turns it
> into the first user-facing analytics surface (dashboards + widgets).
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-6.md`.

> **Note (re-scope):** the original Sprint 6 plan was "Master Data".
> Master Data moved earlier — it shipped inside [Sprint 5](./sprint-5.md)
> (Analytics Engine + Master Data) — and Sprint 6 became the
> **Dashboards & Widgets** sprint, the first consumer of the engine.
> The `/reports/*` and `/embed/*` surfaces remain fail-closed stubs
> (Sprint 9).

---

## Purpose

> **WHAT this is:** the record for Sprint 6 — Dashboards & Widgets.
> **WHY it exists:** customers need to see their ingested data, not just
> query it. Dashboards are the interactive, cached, shareable surface.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-6.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 7 implementer** | Knows the dashboards surface + engine execution contract. (Sprint 7 was re-scoped from Governance to Reports/Alerts/Notifications/Scheduling; see [`phases/sprint-7.md`](./sprint-7.md).) |
| **Tech lead** | Has the delivered dashboard/widget inventory. |

## Current Status

> **Status:** `Complete` (Sprint 6 closed).
> **Sprint:** Sprint 6 — Dashboards & Widgets.
> **Owner:** Engineering team.
> **Verification:** 353 tests total; CI 5/5 green; `npm audit` clean.
> The sprint shipped as re-scoped — every deliverable below is implemented.

## Business Perspective

Dashboards are where customers spend their time: KPI cards, tables and
charts over their own ingested data. Sprint 6 makes them authorable by
non-engineers, cheap to render (cached), and shareable inside the tenant.

## Technical Perspective

A `Dashboard` is a versioned, tenant-scoped container of layout +
filters + widgets. A `Widget` is the unit of execution: it references a
tenant-owned connector as its dataset (`datasetId`) plus a **whitelisted**
analytics query contract (`query`), a chart `type` and a grid position.
Execution (`executeWidget` / `viewDashboard`) runs the safe query contract
through `analytics.engine.js`, scoped to the widget's dataset connector,
with a cache key that encodes the widget/dashboard `updatedAt` revisions so
edits instantly bust cached results.

## Scope

- Dashboard CRUD + lifecycle: create / update / publish / duplicate /
  soft-delete.
- Sharing: email grants (`shareDashboard` / `revokeShare`), audited,
  with a viewer role + optional expiry. No public unauthenticated read
  path yet.
- Widget CRUD (scoped by `(tenantId, dashboardId)`), six types: `kpi`,
  `table`, `bar`, `line`, `area`, `pie`.
- Execution: `executeWidget` (single widget) + `viewDashboard` (all
  widgets, partial failures per-widget).
- Date-range presets on the dashboard/widget filter bar: `today`,
  `yesterday`, `last_7_days`, `last_30_days`, `this_month`,
  `previous_month`, `custom`.
- Cache policy: widget edits bust cached results via `updatedAt`
  revision in the cache key; underlying data changes honour the
  analytics TTL (300 s).
- RBAC: `dashboards.<action>` for authoring; running a widget also
  requires `analytics.view`.

## Deliverables

### Models

- `src/models/Dashboard.js` — `DASHBOARD_STATUSES` (`draft`/`published`/
  `archived`), `DATE_RANGE_PRESETS`, `DASHBOARD_LIMITS` (name/description
  lengths, layout bounds, `MAX_WIDGETS_PER_DASHBOARD` = 30,
  `WIDGET_CACHE_TTL_SEC` = 300), share entries (`email`, `role`,
  `expiresAt`). All five shared plugins.
- `src/models/Widget.js` — `WIDGET_TYPES` (`kpi`/`table`/`bar`/`line`/
  `area`/`pie`), `QUERY_FIELDS` whitelist (`filters`, `filtersOp`,
  `dateRange`, `metrics`, `groupBy`, `orderBy`, `pagination`),
  `WIDGET_LIMITS` (position/name guards). All five shared plugins.

### Service

- `src/services/dashboard.service.js` — `listDashboards`,
  `createDashboard`, `getDashboard`, `updateDashboard`,
  `publishDashboard`, `duplicateDashboard`, `deleteDashboard`,
  `shareDashboard`, `revokeShare`, `listWidgets`, `createWidget`,
  `getWidget`, `updateWidget`, `removeWidget`, `executeWidget`,
  `viewDashboard`. Query-contract whitelisting, layout/filter
  sanitisation, soft-delete cascades, best-effort audit events, and the
  cache-key policy are owned here.

### Routes (real)

- `src/routes/dashboard.routes.js` — full surface behind `authenticate →
  resolveTenant → permission('dashboards', …)`:
  - `GET/POST /`, `GET/PATCH/DELETE /:id`, `POST /:id/publish`,
    `POST /:id/duplicate`, `POST /:id/share`, `DELETE /:id/share/:entryId`
  - `GET/POST /:id/widgets`, `GET/PATCH/DELETE /:id/widgets/:widgetId`
  - `GET /:id/execute` (run dashboard), `GET /:id/widgets/:widgetId/execute`
    (run widget) — both additionally require `analytics.view`.

### Tests (28 added this sprint)

- `tests/dashboards/dashboard.service.test.js` (9) — dashboard
  CRUD/lifecycle/share.
- `tests/dashboards/widget.service.test.js` (8) — widget CRUD + six
  types.
- `tests/dashboards/dashboard.execution.test.js` (7) — `executeWidget` /
  `viewDashboard` engine integration, cache miss→hit + edit bust, tenant
  isolation, fail-closed (404 unknown, 400 foreign/deleted dataset),
  date-preset application, partial failures.
- `tests/dashboards/dashboard.routes.integration.test.js` (4) — HTTP
  end-to-end CRUD + execute + share + duplicate + publish + delete,
  401 no-token, 403 role-less, 422 validation, cross-tenant 404.

## Dependencies

- Sprint 5 (Analytics Engine: `analytics.engine.js` + `analytics.cache.js`)
  + Sprint 4 (Connector Platform: dataset connectors + `ConnectorRow`)
  + Sprint 3 (multi-tenancy + RBAC) + Sprint 2 (permission middleware).

## Testing

- Unit: dashboard/widget service logic (17 tests).
- Integration: engine-backed execution with real MongoDB
  (`mongodb-memory-server`), cache hit/miss + edit-bust, tenant
  isolation, fail-closed paths (11 tests).
- HTTP: end-to-end against the Express app with real auth/RBAC
  (401/403/422) and a full dashboard lifecycle.

## Risks

1. **Cross-tenant leakage through execution.** Mitigated by tenant-scoped
   reads of the dashboard, the widget AND its dataset connector before
   any engine call; a foreign/deleted connector returns 400.
2. **Cache staleness after widget edits.** Mitigated by encoding widget +
   dashboard `updatedAt` revisions into the analytics cache key — editing
   busts the result immediately.
3. **Malformed query smuggling.** The widget `query` field is
   whitelisted to `QUERY_FIELDS`; only those keys are read at execution,
   so a malformed document can never inject aggregation stages.

## Definition of Done

- [x] All deliverables merged.
- [x] Dashboard CRUD + publish / duplicate / share / soft-delete.
- [x] Widget CRUD for six types (kpi, table, bar, line, area, pie).
- [x] Widget + dashboard execution with date presets + cache hit/miss +
      edit-bust.
- [x] Fail-closed execution (404 unknown, 400 foreign/deleted dataset).
- [x] Tenant isolation + RBAC (401/403) verified end-to-end.
- [x] 28 new tests (353 total).
- [x] `STATUS.md` updated.

## Expected Outcome

A tenant user can build a dashboard of KPI/table/chart widgets over their
ingested connectors, run it instantly (cached), share it with a teammate,
duplicate and publish it — with full RBAC and tenant isolation on every
call.

## Best Practices

| Do | Why |
| --- | --- |
| **Whitelist the widget query contract.** | A malformed widget can never smuggle aggregation stages into the engine. |
| **Encode `updatedAt` into the cache key.** | Editing a widget must bust its cached results immediately. |
| **Scope reads by dashboard + tenant before executing.** | Execution is only safe if the widget's dataset is tenant-owned. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Treating `execute` results as a bare rows array.** | The engine returns a result object (`{ rows, total, page, pages, limit, columns, executedAt, groupMode }`). |
| **Expecting metrics from non-grouped queries.** | Aggregation only happens when `groupBy` is non-empty; otherwise raw connector rows are returned. |
| **Assuming `aggregate()` inherits tenancy.** | The engine injects `tenantId` + `deletedAt: null` itself; the plugin chain does not cover `aggregate()`. |

---

## Summary

Sprint 6 delivered the first user-facing analytics surface: dashboards and
widgets over the Sprint 5 engine, with lifecycle, sharing, execution,
caching and RBAC. Master Data shipped earlier (Sprint 5); reports and
embed remain fail-closed stubs for Sprint 9.

## Key Takeaways

- **The widget is the unit of analytics execution**, scoped to a
  tenant-owned dataset connector.
- **The cache key encodes widget/dashboard `updatedAt`** so edits bust
  results.
- **Execution is fail-closed**: unknown dashboard/widget → 404, foreign or
  deleted dataset → 400.

## Interview Preparation

### Common Questions

- "How is a widget executed without leaking other tenants' data?"
- "How do you keep dashboards fast and fresh?"

### Sample Answers

- **"Leakage?"** — The dashboard, the widget and its dataset connector
  are all read tenant-scoped first; the engine then runs the widget's
  whitelisted query contract with the tenant id injected into the leading
  `$match`. A foreign or deleted connector returns 400 before any query.
- **"Fast and fresh?"** — Results are cached under a key that encodes the
  effective query plus the widget/dashboard `updatedAt` revisions, so a
  cached dashboard renders instantly and an edit invalidates the cache
  immediately.

### Real-World Examples

- A tenant ingests regional sales data (Sprint 4), builds a dashboard
  with a `bar` widget grouped by region and a `kpi` sum widget, runs it
  (`last_30_days`), shares it with a teammate, duplicates it for a second
  quarter and publishes it — all over the authenticated API.

### Common Mistakes

- Returning engine result objects where the client expects a bare rows
  array (the envelope includes `total` + pagination + `groupMode`).

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-5.md`](./sprint-5.md) — previous (Analytics Engine + Master Data)
- [`sprint-7.md`](./sprint-7.md) — next (Governance)
- [`../backend/connectors.md`](../backend/connectors.md) — dataset sources

## Last Updated

- **Sprint:** Sprint 6 close (Dashboards & Widgets)
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-12
- **Author:** Engineering (Sprint 6 close, re-scope from Master Data)