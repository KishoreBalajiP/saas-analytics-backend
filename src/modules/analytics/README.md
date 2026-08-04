# Analytics - Dashboards & Reports

The Analytics umbrella turns ingested connector data into **dashboards**
(small, interactive, in-app or embedded) and **reports** (large, scheduled
or one-shot deliverables). It is read-only with respect to source data.

## Submodules

| Submodule     | Responsibility                                       | Entry file                       |
| ------------- | ---------------------------------------------------- | -------------------------------- |
| `dashboards`  | Authoring + viewing dashboards, layouts, sharing     | `routes/dashboard.routes.js`     |
| `reports`     | Scheduled + ad-hoc reports, exports, deliveries      | `routes/report.routes.js`        |

## Architectural principles

1. **Read-only on source data.** Analytics never write to connector sources;
   it reads via the connector `preview`/`ingest` shape and stores results
   only in `analytics.*` collections.
2. **Tenant-scoped.** Every analytics record carries `tenantId` and is
   filtered through `tenantIsolation.middleware.js`.
3. **Cache-friendly.** Heavy aggregations are wrapped in the cache layer
   with explicit `tenantId` + `queryHash` keys.
4. **Async-by-default.** Long-running reports go through `queues/
   analytics.queue.js` and stream progress through `websocket/`.
5. **Reusable engine.** Dashboards and reports share the same query planner
   (via `services/dashboard.service.js` and `services/report.service.js`
   both delegate to a future `services/analytics/engine.js`).

## Dashboards vs Reports

| Aspect        | Dashboards                            | Reports                                |
| ------------- | ------------------------------------- | -------------------------------------- |
| Cardinality   | many per tenant                       | fewer, structured                       |
| Latency       | sub-second (cached)                   | seconds to minutes                      |
| Delivery      | in-app + embed widget                 | email + download + scheduled           |
| Authoring     | rich UI layout, charts                | parameter-based, tabular               |
| Sharing       | per-dashboard roles                   | per-recipient roles                    |
| Storage       | layout JSON + per-tenant caches      | frozen result + presigned URL          |

## Relationship with other modules

- Depends on **connectors** for source data (read-through).
- Depends on **IAM** for sharing/visibility (per-dashboard RBAC).
- Depends on **platform/feature-flags** for early-access dashboards.
- Depends on **queues** + **websocket** for live updates + scheduled runs.
- Emits **governance/audit-logs/** events on share, export and delete.

## Future implementation (Phase 2+)

- A pluggable chart-renderer interface; backend stores config only, the
  frontend interprets.
- A SQL-like query planner over denormalised analytics collections.
- WebSocket rooms `analytics:<tenantId>:dashboard:<id>` for live updates.
- Report schedules expressed as cron + delivery channel matrix.
- Embed widget signature flow via `embed/` + signature middleware.

## Coding guidelines

- Dashboards are *versioned* on save: `{ id, version, layout, queries, ...}`.
- Reports persist their *parameters* along with the frozen result so audits
  can reconstruct what the user saw at delivery time.
- Heavy responses stream via `res.write()` to avoid OOM.

See each `analytics/<submodule>/README.md` for details.
