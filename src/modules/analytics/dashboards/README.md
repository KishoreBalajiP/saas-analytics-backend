# Analytics / dashboards

Dashboards are **interactive views** of analytics data inside the
product. They are versioned (every save makes a new version), tenant-
scoped, and shareable.

## Why it exists

Customers spend most of their SaaS time looking at dashboards. They
must be cheap to render, cache-friendly, shareable across teams, and
authorable by non-engineers.

## Data shape (architecture only)

`models/Dashboard.js`:

```
_id, tenantId, ownerId,
name, description?,
layout: { columns: number, items: Array<LayoutItem> },
queries: Array<{
  id, chart, source,                    // chart id + connector ref
  config: json,
}>,
version: number,                        // optimistic concurrency
status: 'draft' | 'published' | 'archived',
sharedWith: Array<{
  principalType: 'user' | 'role' | 'tenant',
  principalId, permission: 'view' | 'edit'
}>,
lastViewedAt, viewCount,
createdAt, updatedAt, createdBy, updatedBy
```

## Planned endpoints (`/api/v1/dashboards`)

- `GET    /`                  - list (tenant-scoped)
- `POST   /`                  - create
- `GET    /:id`               - detail (with a version)
- `PATCH  /:id`               - update (creates a new version)
- `POST   /:id/publish`       - publish a version
- `POST   /:id/share`         - add share entry
- `DELETE /:id/share/:entry`  - revoke share
- `DELETE /:id`               - delete (soft)

## Architectural shape

- Controller: `src/controllers/dashboard.controller.js`.
- Service: `src/services/dashboard.service.js` - composes queries via the
  analytics engine; handles versioning + sharing.
- Model: `src/models/Dashboard.js`.

## Coding guidelines

- Every save creates an immutable version (cache key includes version).
- Reads cache to `src/cache/` keyed by `{tenantId, dashboardId, version}`.
- Sharing uses `iam/permissions/` indirectly - don't reinvent RBAC.
- Dashboard deletion is soft (audited + retain 30 days).

## Future extension

- Embed widget (signature-based public rendering via `embed/`).
- Realtime rooms `analytics:<tenantId>:dashboard:<id>` for live refresh.
- A marketplace of dashboard templates from Platform Master Data.
