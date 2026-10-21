# Backend — Platform security detection

> **WHAT this is:** the reference for the platform security detection rules,
> the detector job, security alerts and their triage (roadmap 2.6, audit
> document 11 section 4).
> **WHY it exists:** security events must raise alerts someone acts on, not
> only sit in the stores.
> **HOW to use it:** read *Rules* to know what fires; *Operations* to tune it.
> **WHEN to update it:** whenever a rule, a default threshold or the alert
> workflow changes (bump the rule `version` too).
> **WHERE it lives:** `src/docs/backend/security-detection.md`.

## Current Status

> **Status:** `Implemented` — 15 versioned rules, detector job, alerts API,
> on-call notification, admin page `/admin/security-alerts`.

## Architecture

```
event sources ──> rules (versioned code) ──> engine ──> SecurityAlert ──> notifier
LoginAttempt      services/securityDetection   watermark per rule        email / webhook
AuditLog (2.5)    /rules/*.js                  dedupe + merge            (delivery pipeline)
AccessLog                                      false-positive window
AuditExport                                                               admin API + UI
SyncRun                                                                   /admin/security-alerts
SecuritySignal  <── middleware/securitySignals.middleware.js (per-minute counters)
queue snapshot
```

- **Rules** (`src/services/securityDetection/rules/`) are pure reads over
  `(from, to]` that return detections. Each has an `id`, a `version`,
  defaults and typed parameters.
- **Engine** (`engine.js`) runs each enabled rule from its watermark
  (`SecurityDetectionCursor`) to `now - SECURITY_DETECTION_SETTLE_SEC`
  (minus 2 minutes for request-signal rules) in slices of at most one hour,
  then advances the watermark. A rule that throws keeps its watermark.
- **Detector job** (`src/jobs/securityDetection.job.js`, `security-detection`,
  `*/5 * * * *`) runs the engine through the scheduler: lease lock, JobRun
  with counts. A failing rule marks the run failed after the others ran.
- **Request signals** (`SecuritySignal`) are per-minute counters kept by the
  global middleware: API-key calls (key id, errors, client /24 or /48),
  refused calls naming a key (public prefix only), 429s per tenant or range,
  tenant request volume, refused webhook deliveries per connector or per
  range for unknown tokens. No secret, token or full address is stored.
  TTL `RETENTION_SECURITY_SIGNAL_DAYS` (35).

## Rules

| Rule id | Source | Fires when (defaults) | Severity |
| --- | --- | --- | --- |
| `auth.credential_stuffing` | LoginAttempt | ≥ 20 failures for ≥ 10 accounts from one IP in 15 min | high |
| `auth.admin_failed_logins` | LoginAttempt | ≥ 5 failures on one admin account in 15 min | high |
| `auth.admin_new_ip` | LoginAttempt | admin sign-in from an IP not seen for them in 30 days (admins with history) | medium |
| `iam.privilege_change` | security events | super-admin grant (type → super, or role in `superRoleNames` granted to an admin); any refused privilege change (self-targeted called out); optional change window | high (window: medium) |
| `auth.admin_mfa_change` (v2) | security events | MFA disabled for an admin, or reset by another admin (`auth.mfa.reset_by_admin`); admin re-enrols within 90 days of an earlier enrolment/disable (a reset does not count as the earlier event) | high |
| `support.impersonation` | support audit | impersonation start (one alert per admin per UTC day); > 5 per admin per day or target user's email is a platform admin's | medium / high |
| `api_key.new_ip_range` | signals | key with ≥ 20 calls in its 7-day baseline used from a new range | medium |
| `api_key.error_spike` | signals | ≥ 50 calls with ≥ 50 % errors in 15 min | medium |
| `api_key.revoked_use` | signals | ≥ 1 refused call presenting a revoked or deleted key after retirement | medium |
| `traffic.rate_limit_hits` | signals | 429s for a tenant / range in 15 min ≥ max(50, 5 × baseline per window, 7 days) | medium |
| `traffic.request_volume` | signals | tenant requests in 15 min ≥ max(5000, 5 × baseline) | medium |
| `authz.repeated_denials` | AccessLog, `request.denied` | ≥ 20 403s for one caller in 10 min (medium); ≥ 3 cross-tenant / out-of-scope refusals (high) | medium / high |
| `export.unusual_volume` | AuditExport, AccessLog, role grants | exports in 60 min ≥ max(10, 3 × the caller's baseline over 14 days); export within 7 days of a role grant | medium |
| `connector.auth_failures` | signals, SyncRun | ≥ 5 webhook signature refusals / failed syncs (`CONNECTOR_SOURCE_UNAVAILABLE`, `CONNECTOR_AUTH_FAILED`) per connector in 60 min (low); ≥ 20 unknown-token deliveries from one range (medium) | low / medium |
| `resource.consumption` | AccessLog, queues | ≥ 20 requests slower than 5 s per tenant in 15 min on query surfaces; a queue with ≥ 1000 waiting jobs | medium |

Security events are the roadmap 2.5 catalogue (`admin.privilege.changed`,
`admin.privilege.change_denied`, `rbac.role.granted`, `auth.mfa.disabled`,
`auth.mfa.enrolled`, `auth.mfa.reset_by_admin`, `request.denied`); until those writers are integrated
those rules only see the events that exist (`impersonate`).

## Alerts

`SecurityAlert`: rule id + version, title, summary, severity, status
(`open`, `acknowledged`, `false_positive`, `resolved`), subject, tenant,
first/last seen, window, occurrences, evidence (`counts`, `details`, up to
50 `refs` to the underlying rows), owner, acknowledgement and closure
actors, note, history, notifications.

- **Dedupe:** `dedupeKey = <rule>|<subject type>:<subject id>[|<suffix>]`.
  While an alert is open or acknowledged, the same key merges into it
  (unique partial index on `activeKey`); severity only escalates.
- **False positives:** the same key is suppressed for
  `SECURITY_ALERT_FALSE_POSITIVE_SUPPRESS_HOURS` (24) after a dismissal.
- **Retention:** closed alerts follow the audit policy
  (`RETENTION_AUDIT_LOG_DAYS` after `closedAt`, declared in
  `src/constants/retention.detection.js`); open alerts are kept.
- **Audit:** raise, acknowledge, false positive, resolve and failed
  notifications are security events (`security.alert.*`).

## Notification

Alerts at or above `SECURITY_ALERT_NOTIFY_MIN_SEVERITY` (high) notify once,
on creation or escalation, through the delivery pipeline
(`services/delivery`): email to `security.alerts.emails` (platform setting,
array or comma list) or `SECURITY_ALERT_EMAILS`; generic webhook to
`security.alerts.webhookUrl` (secret platform setting) or
`SECURITY_ALERT_WEBHOOK_URL`. The alert records the outcome per channel
(recipients, webhook origin only). With no target configured the
notification is recorded as `skipped` (`NO_TARGETS`).

## API

`/api/v1/admin/security-alerts` (admin session):

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/` (status, severity, ruleId, tenantId, search, from, to, page, limit) | `security.alerts.view` |
| GET | `/rules` | `security.alerts.view` |
| GET | `/:id` | `security.alerts.view` |
| POST | `/:id/acknowledge` (`note` optional) | `security.alerts.update` |
| POST | `/:id/false-positive` (`note` required) | `security.alerts.update` |
| POST | `/:id/resolve` (`note` required) | `security.alerts.update` |

Invalid transitions are 409 `SECURITY_ALERT_STATE_CONFLICT`. Tenant-scoped
admins see only their tenant's alerts.

## Operations

- Thresholds: `SECURITY_DETECTION_RULES_JSON` or the platform setting
  `security.detection.rules` (json), e.g.
  `{"auth.credential_stuffing":{"minFailures":30},"support.impersonation":{"enabled":false}}`.
  Invalid overrides are ignored and listed by `GET /rules`.
- Job: `JOB_SECURITY_DETECTION_ENABLED`, `JOB_SECURITY_DETECTION_CRON`;
  first run looks back `SECURITY_DETECTION_INITIAL_LOOKBACK_MINUTES` (60),
  catch-up capped at `SECURITY_DETECTION_MAX_CATCHUP_HOURS` (24).
- Review tuning and false-positive rates monthly (document 11 section 4).
