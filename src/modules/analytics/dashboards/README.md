# Analytics / dashboards

Dashboards are **interactive views** of analytics data inside the
product. They are tenant-scoped, cache-friendly, and shareable
(Sprint 6 — implemented).

## Why it exists

Customers spend most of their SaaS time looking at dashboards. They
must be cheap to render, cache-friendly, shareable across teams, and
authorable by non-engineers.

## Data shape

`models/Dashboard.js`:

```
_id, tenantId, ownerId,
name, description?,
layout: { columns: number, items: Array<LayoutItem> },
filters: Array<{ field, op, value }>,          // dashboard-level filters
refresh: { enabled, intervalSec },              // optional
status: 'draft' | 'published' | 'archived',
shares: Array<{
  email, role: 'viewer', enabled, expiresAt?, createdBy
}>,
lastViewedAt, viewCount,
createdAt, updatedAt, createdBy, updatedBy
```

`models/Widget.js`:

```
_id, tenantId, dashboardId,
type: 'kpi'|'table'|'bar'|'line'|'area'|'pie',
name, datasetId,                          // tenant-owned connector
query: { filters, filtersOp, dateRange, metrics, groupBy, orderBy, pagination },  // whitelisted
visualization: json,                      // rendering config (backend stores, frontend interprets)
position: { x, y, w, h },
createdAt, updatedAt, createdBy, updatedBy
```

## Endpoints (`/api/v1/dashboards`, Sprint 6 — implemented)

- `GET    /`                  - list (tenant-scoped, status/search)
- `POST   /`                  - create
- `GET    /:id`               - detail (+ widgets)
- `PATCH  /:id`               - update
- `POST   /:id/publish`       - publish a draft
- `POST   /:id/duplicate`     - duplicate (widgets + shares)
- `POST   /:id/share`         - add email share grant
- `DELETE /:id/share/:entryId`- revoke share grant
- `DELETE /:id`               - delete (soft)
- `GET    /:id/widgets`       - list widgets
- `POST   /:id/widgets`       - create widget
- `GET    /:id/widgets/:widgetId`  - get widget
- `PATCH  /:id/widgets/:widgetId`  - update widget
- `DELETE /:id/widgets/:widgetId`  - delete widget
- `GET    /:id/execute`       - run dashboard (all widgets, partial failures per-widget)
- `GET    /:id/widgets/:widgetId/execute` - run a single widget

## Architectural shape

- Controller: `src/controllers/dashboard.controller.js`.
- Service: `src/services/dashboard.service.js` — composes queries via the
  analytics engine; handles lifecycle + sharing + execution + cache policy.
- Models: `src/models/Dashboard.js`, `src/models/Widget.js`.

## Coding guidelines

- Reads cache keyed by `{tenantId, dashboardId, widgetId, updatedAt, ...}`
  — editing a widget/dashboard busts cached results immediately; data
  changes honour the analytics TTL.
- Running a widget requires `dashboards.view` + `analytics.view`.
- Sharing uses audited email grants stored on the dashboard — do not
  reinvent RBAC.
- Dashboard deletion is soft (audited + retain 30 days).

## Future extension

- Embed widget (signature-based public rendering via `embed/`, Sprint 9).
- Realtime rooms `analytics:<tenantId>:dashboard:<id>` for live refresh.
- Reports (`/reports/*`, Sprint 9).
