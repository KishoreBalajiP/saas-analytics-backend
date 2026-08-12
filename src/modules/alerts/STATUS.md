# Module — Status

**Sprint:** 7 (Reports, Alerts, Notifications & Scheduling)
**Status:** ✅ Implemented (Sprint 7 close)
**Implements:** threshold-based alert monitors over the shared analytics
engine, with evaluation, event history, cooldown/deduplication, and
notification dispatch.
**Real source files:**
- `src/models/AlertRule.js`, `src/models/AlertEvent.js`
- `src/services/alert.service.js`
- `src/controllers/alert.controller.js`, `src/routes/alert.routes.js`
- `src/jobs/analytics.worker.js` (alert job type → `alertService.evaluate`)

## What works (verified by integration tests)

- Alert CRUD (tenant-scoped, RBAC `alerts.*`), soft-delete, `nextEvaluationAt`
  projection from the schedule cron.
- Manual + scheduled evaluation through the **real analytics engine**
  (`engine.queryRows`), not a stub.
- `datasetId` is preserved through `sanitizeAlertQuery` so query-source
  alerts remain executable after save/reload.
- Condition evaluation (`gt/gte/lt/lte/eq/neq/between`) against the
  aggregated metric.
- Event history (`AlertEvent`) recorded on trigger.
- **Disabled alerts never trigger** (HTTP, scheduler, and service-level).
- **Cooldown/deduplication**: a second evaluation inside the cooldown window
  is suppressed (`suppressed: true`) and produces no duplicate event; after
  the cooldown elapses (persisted `lastTriggeredAt`) the alert re-triggers.
- Notification dispatch (in-app to `createdBy` + recipients; email channel
  stubbed) on trigger.

## Bugs fixed during Sprint 7

- `sanitizeAlertQuery` stripped `datasetId` (not part of `QUERY_FIELDS`),
  so query-source alerts lost their dataset and failed evaluation. Now
  preserved.
- `AlertEvent` model was missing the `paginate` plugin that
  `alertRepository.listEvents` relies on — added.
- `evaluate` guarded so `enabled === false` rules return
  `{ triggered: false, disabled: true }` and never fire.

## Test coverage

`tests/alerts/alert.routes.integration.test.js` — CRUD, RBAC 401/403, tenant
isolation, evaluation → event + notification, query contract (datasetId
survives reload), disabled guard, cooldown suppression.
`tests/alerts/alert.scheduler.test.js` — `evaluateDue` fires due alerts and
cooldown-dedupes, `runDue` enqueues due reports and advances `nextRunAt`,
disabled alerts skipped by the scheduler, re-trigger after cooldown.

**Last updated:** Sprint 7 close — 2026-08-12.
