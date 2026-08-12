# Sprint 7 — Reports, Alerts, Notifications & Scheduling (✅ Implemented)

> **WHAT this is:** the completion record for Sprint 7 — scheduled
> report generation, threshold alerts evaluated through the real
> analytics engine, the user-facing notification inbox, and the
> shared scheduling/queue integration that runs them.
> **WHY it exists:** Sprint 6 shipped Dashboards & Widgets on top of
> the analytics engine. Customers now want the engine's output delivered
> off the HTTP hot path (scheduled reports, JSON/CSV/XLSX export) and
> watched for thresholds (alerts + notifications).
> **HOW to use it:** read *Actual Delivered Scope* and *Verification*.
> **WHEN to update it:** on closure (now); only bug-fix edits expected
> thereafter.
> **WHERE it lives:** `src/docs/phases/sprint-7.md`.

> **Sprint 7 was re-scoped.** The original roadmap label for Sprint 7
> was *Governance (Audit + Access + Compliance)* — see
> [Originally Planned Scope](#originally-planned-scope-historical) below.
> In this engagement the slot was used for **Reports, Alerts,
> Notifications & Scheduling**, which the dashboards surface immediately
> depends on. The Governance surfaces remain planned and move to
> [Sprint 8](./sprint-8.md). See `STATUS.md` and `CHANGELOG.md` for the
> re-scope note.

---

## Current Status

> **Status:** ✅ **Implemented** (Sprint 7 close — 2026-08-12).
> **Sprint:** Sprint 7 — Reports, Alerts, Notifications & Scheduling.
> **Owner:** Engineering team.
> **Verification (authoritative):** `npm test` → 367 tests, 367 pass, 0
> fail. `npm run ci:guards` → 5 / 5 OK. `npm audit` → 0 vulnerabilities.

---

## Purpose

Move the analytics engine's output **off the HTTP hot path** and **under
watch**:

- **Reports** — authors build a report against an analytics-engine
  source (widget or raw query), publish it, and run it on demand or on
  a schedule. The worker executes the report, serialises the result,
  and stores the artefact + a run-history row.
- **Alerts** — authors define a threshold (e.g. `metric > 100`) over the
  same engine. The scheduler evaluates due alerts, deduplicates against
  a per-rule cooldown, and dispatches a notification when the threshold
  is met.
- **Notifications** — the recipient inbox surfaces alert triggers (and
  other platform events) to the user; tenant- and actor-scoped.
- **Scheduling** — a shared `runDue` / `evaluateDue` + analytics worker
  drives both, with `nextRunAt` / `nextEvaluationAt` advancement.

---

## Intended Audience

| Reader | What they get |
| --- | --- |
| **API consumer (tenant user)** | Can author/run/export reports, define alerts, and read notifications. |
| **Sprint 7 implementer / reviewer** | Has the full implemented surface and verified numbers. |
| **Compliance officer** | The `audit` plugin still emits events for every Sprint 7 mutation; the Governance *consumer* that persists them is planned for Sprint 8 — see the Deferred section. |

---

## Actual Delivered Scope (this sprint)

> Every bullet below is verified by an integration test that runs against
> `mongodb-memory-server` and an HTTP server. Counts come from the
> authoritative `npm test` run on 2026-08-12.

### Reports

- **Reports CRUD** — tenant-scoped, RBAC `reports.*`, soft-delete, draft/
  published status.
  - `POST /api/v1/reports`, `GET /api/v1/reports`, `GET /api/v1/reports/:id`,
    `PATCH /api/v1/reports/:id`, `DELETE /api/v1/reports/:id`.
  - Source `widget` (re-uses a widget's engine query) or `query`
    (ad-hoc filters + groupBy + metrics).
- **Report generation** — `POST /api/v1/reports/:id/run` enqueues an
  `analytics-jobs` message; the **worker** (`analytics.worker.js`)
  resolves the report, runs the real analytics engine, serialises the
  flattened connector rows, writes the artefact to storage, and records
  a run-history row with `rowCount`, `format`, `resultKey`, `status`.
- **JSON / CSV / XLSX export** — `GET /api/v1/reports/:id/export?format=…`
  (`format ∈ {json, csv, xlsx}`). The export is the latest run's
  artefact; download streams the stored buffer with the correct
  `Content-Type` (`application/json` / `text/csv` / XLSX). The
  integration test exercises both `json` and `csv` download paths.
- **Report scheduling** — `Report.schedule = { enabled, format, cron,
  timezone, recipients[] }`. `runDue(now)` scans due reports, enqueues
  a job per report, and advances `nextRunAt`.
- **Execution history** — every run appends a `runs[]` entry with
  `{ runId, triggeredBy, format, status, rowCount, resultKey, startedAt,
  finishedAt }`; runs are queryable per report.

### Alerts

- **Alert rule CRUD** — tenant-scoped, RBAC `alerts.*`
  (`view / create / update / delete / evaluate`), soft-delete.
  - `POST /api/v1/alerts`, `GET /api/v1/alerts`, `GET /api/v1/alerts/:id`,
    `PATCH /api/v1/alerts/:id`, `DELETE /api/v1/alerts/:id`,
    `POST /api/v1/alerts/:id/evaluate`,
    `GET /api/v1/alerts/:id/events`.
- **Alert evaluation through the real engine** — `evaluate({tenantId,
  alertId})` reads the alert's source (`widget` or `query`), calls the
  analytics engine, and feeds the metric value into the comparator. The
  worker runs the alert job type via `analytics.worker.js → alertService.
  evaluate({tenantId, ...params})`.
- **Conditions** — `ALERT_CONDITIONS = ['gt', 'gte', 'lt', 'lte', 'eq',
  'neq', 'between']`. `between` uses both `threshold` and
  `thresholdHigh`.
- **Cooldown / deduplication** — each alert carries `cooldownMinutes`
  and a persisted `lastTriggeredAt`. When a second evaluation fires
  inside the cooldown window the response carries
  `{ triggered: false, suppressed: true }` and **no event row is
  written**. After the cooldown elapses the next evaluation that
  satisfies the condition triggers again (regression-tested).
- **Disabled-alert behavior** — alerts with `enabled === false` return
  `{ triggered: false, suppressed: false, disabled: true }` and never
  fire, regardless of the entry point (manual HTTP, scheduler, retry,
  or service-internal). The scheduler's `evaluateDue` skips disabled
  rules. (Regression-tested.)
- **Notification delivery on trigger** — when an alert triggers the
  service calls `notificationRepository.create(...)` for each user
  recipient (`notification.recipients[].type === 'user'`) and collects
  an email recipient list (`type === 'email'`) for the email channel
  via `email.service` (SMTP / noop transport).

### Notifications (inbox)

- **Inbox lifecycle** — `GET /api/v1/notifications` (paginated, optional
  `unreadOnly`), `GET /api/v1/notifications/unread-count`,
  `PATCH /api/v1/notifications/:id/read`,
  `POST /api/v1/notifications/read-all`,
  `DELETE /api/v1/notifications/:id`,
  `GET /api/v1/notifications/preferences`,
  `PUT /api/v1/notifications/preferences`.
- **Tenant + actor scoping** — every query is keyed by
  `(tenantId, recipientId)`; cross-tenant or wrong-recipient access is a
  404 / empty result.
- **Soft-delete + audit** — `remove` writes a `deleted` audit row;
  `markRead` writes a `markedRead` audit row.
- **RBAC** — `notifications.view` to read, `notifications.update` to
  mark-read, `notifications.delete` to remove, `notifications.configure`
  to manage preferences. 401 without a token, 403 without permission
  (regression-tested).

### Scheduling & queue integration

- **`runDue(now)`** — scans due reports and enqueues a job per report;
  advances `nextRunAt`. Wired through the shared analytics queue
  (`analytics-jobs` queue name).
- **`evaluateDue(now)`** — scans enabled alerts whose
  `nextEvaluationAt` is due and runs each through `evaluate`. Disabled
  alerts are skipped.
- **`analytics.worker.js`** — single consumer that branches on
  `job.data.type`: `report-run` → `reportService.processRun`,
  `alert-evaluate` → `alertService.evaluate`. **Both code paths pass
  `tenantId` through** (the job payload carries `tenantId` at the
  top level alongside `params`).

### RBAC

RBAC is seeded in `tenantInitialization.service.js`:

| Module | Actions |
| --- | --- |
| `reports` | `view`, `create`, `update`, `delete`, `run` |
| `alerts` | `view`, `create`, `update`, `delete`, `evaluate` |
| `notifications` | `view`, `configure`, `update`, `delete` |

The `permission('module', action)` middleware (cached 60 s, invalidated
on write) gates every route. Running a report or evaluating an alert
additionally requires `analytics.view`.

### Tenant isolation

`resolveTenant` (header → JWT claim) injects `req.tenantId`; every
repository call is filtered by `(tenantId, …)`. Cross-tenant
access is a 404 (regression-tested for reports, alerts, notifications).

### Audit logging

Every Sprint 7 mutation emits an `audit` event via the shared
`audit` plugin (Sprint 0):

| Action | Resource | When |
| --- | --- | --- |
| `created` | `report` / `alert` | create |
| `updated` | `report` / `alert` | patch |
| `deleted` | `report` / `alert` / `notification` | soft-delete |
| `run` | `report` | every run (manual + scheduled) |
| `triggered` | `alert` | threshold met, cooldown-elapsed |
| `markedRead` | `notification` | mark-read (single + all) |

> The `audit` plugin events are emitted on every save. The consumer
> that **persists** them as `AuditLog` rows is part of the Governance
> surface (Sprint 8) — see Deferred.

### Security constraints

- Validators reject raw MongoDB operators in query inputs
  (`$where`, `$expr`, `$ne`, `$regex`, …).
- Report and alert query bodies are sanitised through `sanitize*Query`
  to keep the engine input on the safe whitelist (`filters`, `groupBy`,
  `metrics`, `dateRange`, `limit`, `sort`, `datasetId`).
- Sensitive fields are redacted by the `audit` redaction helper before
  any audit row is materialised.
- Email channel goes through `email.service` (SMTP / noop); the in-app
  channel is the primary tested path.

---

## Originally Planned Scope (historical)

The roadmap label for Sprint 7 was **Governance — Audit + Access +
Compliance**. The plan is preserved here for traceability; **none of it
shipped in this sprint** (it moved to Sprint 8).

> **WHAT this was:** the plan for Sprint 7 — audit logs, access logs,
> compliance (GDPR / CCPA-style) endpoints.
> **WHY it existed:** the `audit` plugin already emits events (Sprint
> 0); the Governance sprint was to wire the consumer + the public
> surface.
> **HOW it would have been used:** read *Scope* and *Deliverables*.

### Planned deliverables (now in Sprint 8)

- Models: `src/models/AuditLog.js`, `src/models/AccessLog.js`,
  `src/models/ComplianceRequest.js`.
- Services: `src/modules/governance/audit-logs/audit-log.service.js`,
  `src/modules/governance/access-logs/access-log.service.js`,
  `src/modules/governance/compliance/compliance.service.js`.
- Middleware (real): `src/middleware/audit.middleware.js` (`audit
  (module, action)`), `src/middleware/accessLog.middleware.js`
  (`accessLog`), `src/middleware/compliance.middleware.js`
  (`annotate`, `blockIfDeleted`, `blockIfRestricted`).
- Routes (real): `src/routes/audit-log.routes.js`,
  `src/routes/access-log.routes.js`, `src/routes/compliance.routes.js`.
- Job: `src/jobs/cleanup.job.js` — deletes past-TTL records.
- Consumer: `services/audit.service.js` — subscribes to `audit` events
  and persists structured records.

> The `/access-logs/*` and `/compliance/*` surfaces remain fail-closed
> 501 stubs; they are the next sprint's work.

---

## Deferred to later sprints

| Item | Reason | Target |
| --- | --- | --- |
| Governance surfaces (`/access-logs/*`, `/compliance/*`, `AuditLog` consumer) | Sprint 7 slot re-scoped | Sprint 8 |
| Outbound email consumer + delivery status | SMTP / noop transport is wired; the consumer that drives outbound mail is a later sprint | Sprint 8+ |
| Push + outbound-webhook notifications | In-app + email channels ship; push + webhooks do not | Phase 3 |
| PDF reports | JSON/CSV/XLSX ship | Phase 3 |
| Embed surface (`/embed/*`) | Untouched this sprint | Sprint 9 |
| Per-dashboard realtime refresh rooms | Originally planned in Sprint 6 | Sprint 8+ |

---

## Known limitations

- **`evaluateDue` / `runDue` are not on a cron** — they are
  callable from the worker / a scheduler entry point. The queue
  consumer drains jobs; an external cron (or `node-cron`) must call
  `evaluateDue` / `runDue` on a tick. Wiring the tick is a Sprint 8
  task (alongside the governance cron).
- **`email.service` is best-effort** — outbound delivery is through
  SMTP (or the noop `jsonTransport` in tests). The integration tests
  assert on the in-app channel; the email channel is collected but not
  delivered in this sprint.
- **No PDF export** — `REPORT_FORMATS` is `['json', 'csv', 'xlsx']`.
- **Report artefact storage** — uses `storage.service` (local by
  default, S3-compatible when `STORAGE_PROVIDER=s3`); `xlsx` exports
  are stored with extension `.xls` (browser-friendly).

---

## Verification (authoritative — 2026-08-12)

| Command | Result |
| --- | --- |
| `npm test` (with `PASSWORD_KDF=scrypt`, default `NODE_ENV=development`) | **367 tests, 367 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo.** Duration ≈ 39 s. |
| `npm run ci:guards` | **5 / 5 OK** — `check-stubs`, `check-routes`, `check-models`, `check-config`, `check-readme-sync`. Output: `ci:guards OK`. |
| `npm audit` | **found 0 vulnerabilities**. |

> **Note on `NODE_ENV`:** `npm test` must NOT force `NODE_ENV=test` —
> the `health.test.js` spec asserts `env === 'development'`. Running
> plain `npm test` defaults to development; `PASSWORD_KDF=scrypt` keeps
> the suite portable without native Argon2.

---

## Tests added in this sprint (14 total)

| File | Tests | Coverage |
| --- | --- | --- |
| `tests/reports/report.routes.integration.test.js` | 3 | CRUD + RBAC 401/403, tenant isolation (cross-tenant 404), run → ready with rows, JSON/CSV export download, security (raw operators rejected). |
| `tests/alerts/alert.routes.integration.test.js` | 5 | CRUD + RBAC 401/403, evaluation → event + notification, **datasetId contract** (create→reload→evaluate triggers), **disabled guard**. |
| `tests/alerts/alert.scheduler.test.js` | 4 | `evaluateDue` fires due alerts and cooldown-dedupes; `runDue` enqueues due reports and advances `nextRunAt`; **disabled alerts skipped by scheduler**; **re-trigger after cooldown**. |
| `tests/notifications/notification.routes.integration.test.js` | 2 | Inbox lifecycle + RBAC 401/403. |

Suite grew **353 → 367** (+14).

---

## Files (verified)

### Models
- `src/models/Report.js` — `REPORT_FORMATS = ['json', 'csv', 'xlsx']`,
  schedule (`enabled`, `format`, `cron`, `timezone`, `recipients[]`),
  `runs[]` history, `nextRunAt`; all five plugins.
- `src/models/AlertRule.js` — `ALERT_CONDITIONS = ['gt', 'gte', 'lt',
  'lte', 'eq', 'neq', 'between']`; `ALERT_SOURCES = ['widget', 'query']`;
  `ALERT_CHANNELS = ['email', 'in_app']`; `cooldownMinutes`,
  `lastTriggeredAt`, `nextEvaluationAt`, `enabled`,
  `notification.{channels, recipients, template}`.
- `src/models/AlertEvent.js` — event history; **added `paginate`
  plugin** in Sprint 7.
- `src/models/Notification.js` — tenant/actor-scoped inbox;
  preferences.

### Services
- `src/services/report.service.js` — `create`, `update`, `list`, `get`,
  `remove`, `run`, `exportReport`, `processRun`, `runDue`.
  `sanitizeReportQuery` preserves `datasetId`.
- `src/services/alert.service.js` — `create`, `update`, `list`, `get`,
  `remove`, `evaluate`, `evaluateDue`, `runDue`. `sanitizeAlertQuery`
  preserves `datasetId`. Disabled guard + cooldown in `evaluate`.
- `src/services/notification.service.js` — `listInbox`,
  `getUnreadCount`, `markRead`, `markAllRead`, `remove`,
  `getPreferences`, `updatePreferences`.

### Repositories
- `src/repositories/report.repository.js`, `alert.repository.js`,
  `notification.repository.js`.

### Controllers + routes
- `src/controllers/report.controller.js`,
  `src/controllers/alert.controller.js`,
  `src/controllers/notification.controller.js`.
- `src/routes/report.routes.js` (full surface incl. `/:id/run`,
  `/:id/export`), `src/routes/alert.routes.js` (full surface incl.
  `/:id/evaluate`, `/:id/events`), `src/routes/notification.routes.js`
  (full inbox surface).
- `src/routes/index.js` — `alert.routes` registered.

### Validators
- `src/validators/report.validators.js`, `alert.validators.js`,
  `notification.validators.js` — `validate()`-compatible schemas;
  reject raw MongoDB operators.

### Worker
- `src/jobs/analytics.worker.js` — branches on `job.data.type`
  (`report-run` → `processRun`, `alert-evaluate` → `evaluate`); **passes
  `tenantId` through**.

### RBAC seed
- `src/services/tenantInitialization.service.js` — adds `reports`,
  `alerts` (with `evaluate`), and `notifications` actions per role.

### Deleted (orphan / redundant)
- `src/services/reportQueryBuilder.service.js`,
  `src/services/alertEvaluator.service.js` — removed; the real flow
  is `report.service` / `alert.service` over the analytics engine +
  `Connector` as dataset.

### Tests (4 new files)
See *Tests added in this sprint*.

---

## Bugs fixed in Sprint 7 (real, not test hacks)

| Symptom | Root cause | Fix |
| --- | --- | --- |
| Query-source alerts evaluated to 0 / failed | `sanitizeAlertQuery` stripped `datasetId` (not in `QUERY_FIELDS`) | Preserve `datasetId` through the sanitiser. |
| `GET /alerts/:id/events` threw `AlertEvent.paginate is not a function` | `AlertEvent` model was missing the `paginate` plugin | Add `paginate` plugin to `AlertEvent`. |
| Query-source reports returned 0 rows | `sanitizeReportQuery` stripped `datasetId` (same class of bug) | Preserve `datasetId` through the sanitiser. |
| Reports returned 0 rows even with a `datasetId` | `analytics.worker.js` extracted only `params` from the job payload, dropping top-level `tenantId`; `processRun`/`evaluate` ran with `tenantId: undefined` | Worker now passes `{ tenantId, ...params }` to both service methods. |

---

## Risks (as observed)

1. **Scheduling tick** — `runDue` / `evaluateDue` are not self-driving.
   An external scheduler must invoke them. This is a Sprint 8
   deliverable.
2. **Cooldown window is wall-clock minutes** — `cooldownMinutes` is
   not jittered; back-to-back ticks can land on the same minute and
   produce a tight burst. Acceptable for now.
3. **Email delivery is best-effort** — the in-app channel is the
   tested path; email requires an SMTP target that is not always
   available.
4. **Notification preferences are per-user, not per-tenant** — a
   tenant-wide notification policy (e.g. quiet hours) is Phase 3.

---

## Best Practices

| Do | Why |
| --- | --- |
| **Use the analytics engine, never re-implement the query in the report/alert service.** | The engine is the source of truth for tenant scoping + cache + permissions. |
| **Run the worker off the HTTP path.** | A `/reports/:id/run` request should enqueue and return 202-style, not block. |
| **Guard `enabled === false` in `evaluate`, not only in the scheduler.** | Defence in depth: HTTP, retry, service-internal, and scheduler must all agree. |
| **Preserve `datasetId` in every query sanitiser.** | It is not part of `QUERY_FIELDS` by design (it's not a *filter*), but losing it silently breaks execution. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| Dropping `tenantId` when re-bundling a job payload. | The engine returns 0 rows with no tenant. |
| Forgetting the `paginate` plugin on a listable event model. | `repository.list*` throws. |
| Treating "alert disabled" as a scheduler concern only. | A disabled alert can be triggered by manual `/evaluate` if the guard lives only in `evaluateDue`. |
| Logging response bodies in alert/reports. | They can include tenant rows. |

---

## Definition of Done

- [x] All deliverables merged (see *Files*).
- [x] Reports CRUD, generation, JSON/CSV/XLSX export, scheduling, history.
- [x] Alert rule CRUD, evaluation through the real engine, conditions,
      cooldown, disabled-guard.
- [x] Notification inbox (list, unread-count, mark-read single + all,
      delete, preferences) with tenant + actor scoping.
- [x] Scheduling via `runDue` / `evaluateDue`; analytics worker.
- [x] RBAC + tenant isolation regression-tested.
- [x] Audit events emitted on every mutation.
- [x] **367 tests pass**, 5/5 CI guards green, 0 npm audit vulns.
- [x] `STATUS.md`, `CHANGELOG.md`, `AI_CONTEXT.md`, and module
      `STATUS.md` files updated with actual numbers.
- [x] This sprint doc rewritten to reflect actual delivery.

---

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-6.md`](./sprint-6.md) — previous (Dashboards & Widgets)
- [`sprint-8.md`](./sprint-8.md) — next (Monitoring + Support; includes the
  originally-planned Governance surfaces)

## Last Updated

- **Sprint:** Sprint 7 close — Reports, Alerts, Notifications & Scheduling
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-12
- **Author:** Engineering / Docs (Sprint 7 close)