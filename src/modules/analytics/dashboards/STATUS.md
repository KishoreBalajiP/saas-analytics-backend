# Module — Status

**Sprint:** 6 — Dashboards & Widgets
**Status:** ✅ Implemented

**Implements:** tenant-scoped dashboard + widget authoring and widget
analytics execution over the Sprint 5 analytics engine:

- Dashboard lifecycle: CRUD, `publish` / `duplicate` / soft-delete,
  email-grant sharing (`shareDashboard` / `revokeShare`, audited).
- Widget CRUD for six types (`kpi`, `table`, `bar`, `line`, `area`,
  `pie`), scoped by `(tenantId, dashboardId)`, with a whitelisted safe
  query contract (`QUERY_FIELDS`) so a malformed widget can never smuggle
  aggregation stages into the engine.
- Execution: `executeWidget` (single widget) + `viewDashboard` (all
  widgets, partial failures per-widget) via `analytics.engine.js`,
  scoped to the widget's tenant-owned dataset connector.
- Cache: key encodes the effective query plus widget/dashboard
  `updatedAt` revisions — editing a widget busts its cached results;
  underlying data changes honour the analytics TTL (300 s).
- Date-range presets: `today`, `yesterday`, `last_7_days`, `last_30_days`,
  `this_month`, `previous_month`, `custom`.
- Fail-closed execution: unknown dashboard/widget → 404; foreign or
  deleted dataset connector → 400.

**Real source files:**

- `src/models/Dashboard.js`, `src/models/Widget.js` — all five shared
  plugins (tenantScope, softDelete, paginate, optimisticConcurrency,
  audit); widget index `{tenantId, dashboardId}`.
- `src/services/dashboard.service.js` — lifecycle, sharing, widget CRUD,
  execution, cache-key policy, audit events.
- `src/services/widget.service.js` — widget types + query-contract
  validation.
- `src/routes/dashboard.routes.js` — full `/api/v1/dashboards/*` surface
  (incl. `/:id/execute` + `/:id/widgets/:widgetId/execute`) behind
  `authenticate → resolveTenant → permission('dashboards', …)`; running a
  widget also requires `analytics.view`.
- `src/controllers/dashboard.controller.js`, `src/validators/
  dashboard.validator.js`.

**Testing:** 28 tests — `tests/dashboards/dashboard.service.test.js` (9),
`widget.service.test.js` (8), `dashboard.execution.test.js` (7),
`dashboard.routes.integration.test.js` (4).

**Depends on:** Sprint 5 (analytics engine + cache), Sprint 4
(connectors: dataset connectors + `ConnectorRow`), Sprint 3
(multi-tenancy + RBAC), Sprint 2 (permission middleware).

**Not shipped yet:** `/reports/*` + `/embed/*` remain fail-closed stubs
(Sprint 9).
