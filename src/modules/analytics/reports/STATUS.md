# Module — Status

**Sprint:** 7 (Reports, Alerts, Notifications & Scheduling)
**Status:** ✅ Implemented (Sprint 7 close)
**Implements:** scheduled, tenant-scoped report generation. Reports are
authored against the shared analytics engine (widget source or raw query
source), executed off the HTTP hot path via the analytics queue worker, and
exported as JSON / CSV / XLSX. Execution history is persisted.
**Real source files:**
- `src/models/Report.js`
- `src/services/report.service.js`
- `src/controllers/report.controller.js`, `src/routes/report.routes.js`
- `src/jobs/analytics.worker.js` (report job type → `reportService.processRun`)

## What works (verified by integration tests)

- Report CRUD (tenant-scoped, RBAC `reports.*`), draft/published status,
  soft-delete.
- Run + export: `POST /:id/run` enqueues an `ANALYTICS_JOBS` message; the
  worker (`analytics.worker.js`) runs `processRun`, generates the artefact
  via the **real analytics engine**, stores it, and records the run.
- JSON / CSV / XLSX serialisation of flattened connector rows.
- Execution history (`runs[]` with status, `rowCount`, `resultKey`).
- Scheduled reports: `runDue` enqueues due reports and advances `nextRunAt`.
- `datasetId` is preserved through `sanitizeReportQuery` so query-source
  reports remain executable.

## Bugs fixed during Sprint 7

- `sanitizeReportQuery` stripped `datasetId` (not part of `QUERY_FIELDS`),
  so query-source reports failed execution with "report query requires a
  datasetId". Now preserved.
- The analytics worker dropped `tenantId` (it lived at `job.data.tenantId`,
  sibling to `params`), so `processRun` ran with `tenantId: undefined` and
  the engine returned 0 rows. The worker now passes `tenantId` through to
  `processRun` / `evaluate`.

## Test coverage

`tests/reports/report.routes.integration.test.js` — CRUD, RBAC 401/403,
tenant isolation (cross-tenant 404), run → ready with rows, JSON/CSV export
download, security (raw MongoDB operators / `$where` / `$expr` rejected).

**Last updated:** Sprint 7 close — 2026-08-12.
