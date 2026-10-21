# 07. Dashboards, visualization, reports and alerts

**Audience:** engineers and product owners responsible for the analytics authoring and consumption experience.

**Summary.** Dashboard persistence is solid: create, update, publish, duplicate and soft-delete are implemented and tested, and widget execution is tenant-isolated and cached. The weaknesses are in what the numbers mean and how they leave the product. Charts choose series by runtime type-guessing and ignore the stored visualization settings; date windows are computed in server time on ingestion timestamps; reports export at most one page of results while reporting the full row count ({{ANA:report-truncated}}); relative date windows in reports and alerts are frozen at save time ({{ANA:frozen-presets}}); scheduled reports are generated but never delivered ({{ANA:no-delivery}}); "sharing" stores recipients that nothing reads; and an alert with a malformed schedule re-triggers every minute, sending an email each time ({{ANA:alert-cron}}).

## 1. Dashboard lifecycle (brief §7.1)

| Capability | Status | Evidence and notes |
|---|---|---|
| Create, edit, save, reload | **Implemented and verified** | `backend/src/services/dashboard.service.js:302-424`; layout and filters sanitised (`:91-141`); `tests/dashboards/dashboard.service.test.js:75-146`, `dashboard.routes.integration.test.js` |
| Viewing widget data in the UI | **Broken** | `viewDashboard` returns each widget as `{ widgetId, …, result: { …, result: engineResult } }` (`backend/src/services/dashboard.service.js:569-576,598-601`), but the UI passes `execution.result` straight to `WidgetView`, which reads `.rows` (`frontend/src/features/dashboards/components/DashboardDetailView.tsx:225`, `frontend/src/components/common/WidgetView.tsx:70`). No widget on a dashboard ever renders data ({{FE:dashboard-shape}}). The page is also blocked earlier by the empty-permission gate ({{FE:perm-gate}}) |
| Duplicate | **Implemented and verified** (API) | Duplicates widgets; tested. No UI action exists for publish, duplicate or share |
| Delete | **Implemented and verified** for dashboard + widgets | Cascades to widgets only; reports, alerts and embed tokens that reference the dashboard keep running and fail with "Dashboard not found" |
| Publish | **Implemented** | Flips `status` to `published`; used as the gate for embedding (itself broken, document 09) |
| Share with users | **Planned or documented only** | `shares` are written and listed but no authorisation path consults them (`backend/src/models/Dashboard.js:19-23` says so) |
| Versioning / recovery | **Missing** | No versions; documented as a deliberate downgrade (`Dashboard.js:11-17`) |
| Widget types | kpi, table, bar, line, area, pie | `backend/src/models/Widget.js:35` |
| Widget authoring UX | **Partially implemented** | The editor takes the widget query as a raw JSON textarea (`frontend/src/features/dashboards/components/DashboardEditor.tsx`), so non-technical users cannot build widgets; field pickers do not exist |
| Filters, parameters, date ranges | **Partially implemented** | Dashboard-level default filters and date presets exist; presets act on ingestion time and server-local time ({{ANA:date}}, {{ANA:timezone}}) |
| Drill-down | **Missing** | |
| Refresh | **Partially implemented** | `refresh.intervalSec` is stored and validated (30–86,400 s) but no client or server enforces it |
| Export | **Partially implemented** | Report exports exist (capped); analytics async export is broken ({{ANA:export-broken}}) |
| Quotas | **Broken** | Updating or deleting a dashboard and adding a widget each consume a `dashboards` quota unit that is never released; the free plan's limit of 5 is reached after a few edits ({{ANA:quota}}) |
| Empty and error states | Present | Shared `EmptyState`/`ErrorState`; per-widget errors are returned as strings in `viewDashboard` |

## 2. Visualization correctness (brief §7.2)

| Concern | Finding | Recommendation |
|---|---|---|
| Visualization config | `widget.visualization` is stored unvalidated and the renderer ignores it (`frontend/src/components/common/WidgetView.tsx:51-59,81-84,123-124` pick series and labels by `typeof`) | Define a typed visualization spec per widget type (x field, series fields, number format, unit, sort, limit, null handling) validated on the server and honoured by the renderer |
| Numeric dimensions | A numeric group key (for example `year`) is plotted as a metric series | Use the spec, not type-guessing, to separate dimensions from measures |
| KPI on raw rows | A KPI over a non-grouped query shows a field such as `connectorId` | KPI widgets must require an aggregate metric |
| Aggregation semantics | `count` ignores its field (counts rows, not non-null values); `avg` over all-null returns null, which the UI treats as non-numeric; one non-numeric string aborts `sum/avg/min/max` ({{ANA:tostring}}) | Support `count` (rows) and `count_non_null`/`count_distinct`; coerce with `$convert … onError`; surface "n values excluded" |
| Time axes and time zones | No time bucketing; presets in server-local time | `$dateTrunc` buckets in the tenant time zone; label axes with the zone |
| Units, currency, decimals | Not modelled | Metric definitions carry unit and format (document 08 §4.3) |
| Category limits and large results | Rows capped at 200 per page; table widgets cannot page beyond the first page; charts silently truncate | Show "top N of M" with an "other" bucket; paging for table widgets |
| Silent filter loss | Unknown or malformed filters are dropped and the chart renders unfiltered data ({{ANA:silent-drop}}) | Reject invalid queries at save time with field-level errors |
| Contract mismatch | UI `groupBy` strings collapse grouped charts to one bar ({{AI:groupby}}); frontend types `groupMode` as a string while the backend returns a boolean | Shared contract and contract tests (document 17) |
| Provenance | Charts do not show the data window, time zone, dataset freshness or metric definition | Add a "how this was calculated" panel (document 08 §4.1) |

## 3. Reports and scheduled delivery (brief §7.3)

| Capability | Status | Evidence |
|---|---|---|
| Report CRUD | **Implemented** | `backend/src/services/report.service.js:272-490`; `permission('reports', …)` |
| Ad-hoc run through the worker, artefact stored, download | **Implemented but incompletely verified** | `tests/reports/report.routes.integration.test.js:60-97` (create → run → ready → download) |
| Artefact completeness | **Broken** | At most one engine page (≤ 200 rows, default 50) is serialised while `rowCount` reports the total; the only test asserts `rowCount >= 1` ({{ANA:report-truncated}}) |
| Formats | JSON, CSV, "XLSX" | The XLSX option is an HTML table sent as `application/vnd.ms-excel` with a `.xls` name, although `exceljs` is a dependency |
| Relative date windows | **Broken** | Saving a report or alert resolves "last 7 days" to fixed dates, so every scheduled run repeats the same window ({{ANA:frozen-presets}}); report-level `dateRange`/`filtersOp` overrides are stored but never applied ({{ANA:report-overrides}}) |
| Schedules | **Implemented but incompletely verified** | Cron stored per report; a per-minute job enqueues due runs. Cron is evaluated in UTC; the stored `timezone` is ignored ({{ANA:timezone}}); invalid cron causes a 500 on create/update |
| Duplicate-run protection | **Missing** | No atomic claim, no overlap guard; `nextRunAt` advanced after enqueue; every instance runs every tick ({{ANA:sched-dup}}) |
| Delivery to recipients | **Missing** | `schedule.recipients` is stored and never read; the service imports no email or notification module; the frontend schedule form has no recipients field ({{ANA:no-delivery}}) |
| Delivery tracking, retries, failure alerts | **Missing** | |

**Do not describe reports as "scheduled delivery" until** recipients receive a complete artefact or link, each delivery is recorded with status and retry, and failures notify the report owner.

## 4. Alerts and notifications

| Capability | Status | Evidence and notes |
|---|---|---|
| Threshold rules (gt, gte, lt, lte, eq, between) | **Implemented but incompletely verified** | `backend/src/services/alert.service.js:384-451`; tests for trigger, cooldown, disabled rules |
| Metric extraction | **Broken for grouped and raw queries** | Sums the metric across the returned page only, and ignores the configured metric in raw mode ({{ANA:alert-metric}}) |
| Cooldown | **Partially implemented** | Suppressed evaluations never advance `nextEvaluationAt` or record an event, so a cooling-down rule is re-evaluated every minute ({{ANA:cooldown}}) |
| Invalid schedule handling | **Broken** | Cron is not validated on create; evaluation creates the event and sends notifications **before** computing the next run, which then throws; the rule stays due and fires again every minute, emailing each time ({{ANA:alert-cron}}) |
| In-app notification inbox | **Implemented and verified** | `tests/notifications/notification.routes.integration.test.js` |
| Email channel | **Implemented, unverified in production** | Sent synchronously through nodemailer for alerts only; any external address can be a recipient and the subject embeds the user-controlled alert name |
| Notification preferences | **Mocked or simulated** | Repository returns hard-coded values; `POST /notifications/preferences` persists nothing |
| Anomaly detection | **Planned or documented only** | Stub job; see document 08 §9 |

## 5. Recommendations

1. **Make the numbers right first:** business-date filtering and tenant time zones, typed numeric coercion, strict query validation, full-result report artefacts (stream all pages to storage), relative presets stored as presets and resolved at run time.
2. **Visualization spec:** validated per widget type and honoured by the renderer; replace the JSON textarea with a field-picker builder that writes the same spec.
3. **Scheduling as a durable job:** claim due work atomically (`findOneAndUpdate` on `nextRunAt <= now` with a lease), compute `nextRunAt` in the schedule's time zone before side effects, validate cron at save time, and record each run.
4. **Delivery pipeline:** an outbox collection for emails (and later Slack/webhook channels) with retries, bounce handling and per-recipient status; recipients restricted to tenant members by default, external addresses allowed only by an owner setting; links that require sign-in instead of attachments for sensitive data.
5. **Sharing:** either implement per-dashboard grants in the authorisation path (viewer/editor, members and groups) or remove the inert `shares` API and UI.
6. **Fix quotas:** count dashboards that exist, not operations performed.

## 6. Findings in this area

{{ANA:alert-cron}}, {{ANA:expr}}, {{ANA:report-truncated}}, {{ANA:frozen-presets}}, {{ANA:quota}}, {{ANA:alert-metric}}, {{ANA:cooldown}}, {{ANA:export-broken}}, {{ANA:no-delivery}}, {{ANA:tostring}}, {{ANA:silent-drop}}, {{ANA:cache}}, {{ANA:timezone}}, {{ANA:report-overrides}}, {{ANA:sched-dup}}, {{ANA:date}}, {{AI:groupby}}. Full details are in `19-findings-register.md`.
