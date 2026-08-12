# Module — Status

**Sprint:** 5 (Analytics Engine) + 6 (Dashboards)
**Status:** ✅ Implemented

**Implements:** the analytics umbrella that turns ingested connector
data into **dashboards** (interactive, cached, shareable — Sprint 6) and,
later, **reports** (Sprint 9). The module is read-only with respect to
source data.

**Sprint 5 — Analytics Engine + Master Data (implemented):**

- `src/services/analytics.engine.js` — normalised query → one MongoDB
  aggregation over `ConnectorRow`: filters (`eq, neq, in, nin, gt, gte,
  lt, lte, exists`), `filtersOp` and/or, date-range window, metrics
  (`count, sum, avg, min, max`), `groupBy` aggregation or raw rows,
  sort, pagination, projection. Always injects `tenantId` +
  `deletedAt: null` into the leading `$match` (aggregate bypasses the
  tenantScope plugin).
- `src/services/analytics.service.js` + `analytics.cache.js` — cached
  query execution (key = `tenantId` + query hash), run history via
  `src/models/AnalyticsQuery.js`, async exports.
- `src/routes/analytics.routes.js` — `GET /`, `GET /queries`,
  `GET /queries/:id`, `POST /export` behind `authenticate →
  resolveTenant → permission('analytics', …)`.
- Master Data: `src/models/MasterData.js` +
  `src/services/masterData.service.js` + `src/routes/master-data.routes.js`
  — admin write, public cached read (`master-data:<category>`).

**Sprint 6 — Dashboards & Widgets (implemented):** see
`analytics/dashboards/STATUS.md`.

**Real source files:** `src/services/{analytics.engine,analytics.service,
analytics.cache,analytics.scheduler,masterData}.js`,
`src/repositories/analytics.repository.js`, `src/models/{AnalyticsQuery,
MasterData,Dashboard,Widget}.js`, `src/routes/{analytics,master-data,
dashboard}.routes.js`.

**Testing:** 40 tests (analytics engine/service/cache/controller +
master data) + 28 dashboard tests = 68 total for the module.

**Depends on:** Sprint 4 (connectors: `ConnectorRow`), Sprint 3
(multi-tenancy + RBAC).

**Not shipped yet:** `/reports/*` and `/embed/*` remain fail-closed stubs
(Sprint 9).
