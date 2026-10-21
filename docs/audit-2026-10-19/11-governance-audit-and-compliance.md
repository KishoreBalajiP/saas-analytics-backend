# 11. Audit logging, governance, compliance and security monitoring

**Audience:** whoever owns security, privacy and compliance for Analivo, and the engineers implementing the controls.

**Summary.** Analivo has a real, tested, application-level audit trail: model changes are captured by a Mongoose plugin and an audit consumer, important domain actions emit explicit audit events, records carry actor, action, resource, tenant, timestamp and request id, and audit exports run asynchronously with permission checks. It is not yet something governance claims can rest on. Retention is not enforced at all because the cleanup job is a stub ({{GOV:retention}}); the audit plugin misses most non-`save` mutations, including deletes and bulk updates ({{GOV:plugin-gaps}}); redaction both misses secret-bearing fields and corrupts dates ({{GOV:redaction-gaps}}, {{GOV:redact-dates}}); login, password and MFA events are not in the audit trail ({{GOV:auth-events}}); the audit-log read API ignores the scoped-support boundary ({{GOV:auditlog-scope}}); and there is no platform security anomaly detection or alerting beyond per-account login lockout ({{GOV:no-security-detection}}).

## 1. Audit logging (brief §11.1)

### 1.1 Coverage of required events

| Event | Recorded today? | Mechanism | Gap |
|---|---|---|---|
| Login success / failure | Partially | `LoginAttempt` collection (write-only, no API or consumer) | Not in the audit trail; no alerting ({{GOV:auth-events}}) |
| Password reset / change, MFA enrol / disable | No (only incidental session writes) | — | Must be explicit security events |
| Role and permission changes | Partially | Model plugin on `Role`, `RolePermission`, `UserRole`, `AdminRole` | Revocations via `deleteOne`/`deleteMany` are not captured ({{GOV:plugin-gaps}}) |
| Administrator invitations and lifecycle | Yes | Explicit events in `admin.service.js` | |
| Tenant lifecycle | Yes | Explicit events in `tenantLifecycle.service.js` | |
| Membership changes | Partially | Invitation events; no member removal exists | |
| Connector creation and modification | Partially | Model plugin; non-lean `findOneAndUpdate` rows dropped, lean ones lose `before` | |
| API-key create / rotate / revoke | Yes (attribution null) | Model plugin + explicit events; actor id read from `req.user._id` (undefined) | Also: every external call's `lastUsedAt` write creates a row (noise) |
| Embed configuration changes | Yes (attribution null) | as above | |
| Sensitive exports | Yes | Audit export pipeline emits events | |
| Data deletion | Partially | Soft deletes via save are captured; hard deletes are not | |
| Plan and entitlement changes | Yes | Explicit billing/entitlement events | |
| Support access / impersonation | Yes (start and stop) | Double-logged (audit + access log) | Actions during impersonation attributed to the impersonated user ({{GOV:impersonation-attribution}}) |
| Configuration changes | n/a | Settings/flags/templates routes are 501 | |
| Denied and failed requests | No | Request-level `audit.middleware.js` is never mounted on mutating routes ({{GOV:audit-mw}}) | |

### 1.2 Record quality and protection

| Property | Status |
|---|---|
| Actor, action, resource, tenant, timestamp, request id | Present on explicit events; plugin rows from unauthenticated flows are attributed to `system` |
| Sensitive content | Redaction misses `secretHash`, `tokenHash`, encrypted connector configuration, webhook tokens and raw provider payloads that the plugin snapshots on create; `redact()` turns every `Date` into `{}` and mangles ObjectIds in before/after snapshots ({{GOV:redaction-gaps}}, {{GOV:redact-dates}}) |
| Immutability | Application-level append-only guard on `AuditLog`, partial and untested; `AccessLog` and `LoginAttempt` have none ({{GOV:append-only}}). The database credential can still update or delete audit rows |
| Scope enforcement on read | `/audit-logs` ignores a scoped admin's `tenantScope`, unlike sibling surfaces ({{GOV:auditlog-scope}}) |
| Export | Permission-gated, asynchronous, tenant-bounded; artefacts never expire because status polls re-sign a fresh 24-hour URL indefinitely ({{GOV:export-expiry}}); access-log export drops access-log-specific filters; CSV cells are not protected against spreadsheet formula injection |
| Retention | `RETENTION_*` settings are parsed and never used; audit, access, login-attempt, session and export data grow without bound ({{GOV:retention}}) |

### 1.3 Recommendations

1. Introduce a single `securityEvent()` API for authentication, MFA, permission and support events, writing to the audit trail with a fixed schema and severity.
2. Capture all mutation paths: use explicit service-level events for deletes and bulk updates rather than relying on the plugin's `post('save')` hooks.
3. Redaction by allow-list (fields that may be stored) instead of deny-list; serialise dates and ids correctly; never snapshot encrypted blobs or hashes.
4. Make the audit store tamper-evident: a separate database user with insert-only rights for the audit collection, a hash chain or periodic signed digests, and export to write-once object storage or a SIEM.
5. Implement retention as a real job (document 12), per collection, with legal-hold support and a report of what was purged.

## 2. Compliance and governance centre (brief §11.2)

The `compliance` module implements data-subject requests (file, list, cancel; export, delete, restrict, consent processors; a public poll token). Today "delete" is a soft delete plus session revocation and the evidence record keeps the subject's email; "restrict" and "consent" are recorded but not enforced; tenant users can file an immediately-executed delete; the poll token is keyed with `JWT_SECRET` ({{GOV:dsr}}). The frontend's `/admin/compliance` page is a "Coming soon" placeholder although the backend routes exist.

A governance centre is worth building incrementally on what exists:

| Control area | Build on | First deliverable |
|---|---|---|
| Access reviews | Roles, `AdminRole`, `UserRole` | Quarterly export of every admin and tenant-owner grant with last login, signed off in the product |
| Administrator lifecycle | Admin routes | Joiner/mover/leaver checklist with audit evidence |
| Data inventory and classification | Schema catalogue (document 08) | Per-dataset field classification (personal, sensitive, financial, none) set by the tenant, with defaults from profiling |
| Retention and deletion | Cleanup job, compliance processors | Per-collection retention policy, purge reports, verified tenant deletion |
| Data export | Report/audit export | Owner-initiated full tenant export |
| Incident handling | Document 12 | Incident records linked to affected tenants |
| Vendor and provider inventory | This document §3 | Maintained list with data categories, region and contract status |
| Backup and recovery | Document 12 | Restore drill evidence |
| Change management | Git + CI (to be added) | Protected `main`, required reviews and checks |
| Policies and risk register | `docs/` | Versioned policy documents and a risk register reviewed quarterly |

**What can truthfully be claimed today:** an application-level audit trail with actor, action, resource, tenant, time and request id; permission-gated, tenant-bounded audit exports; support impersonation that requires a reason and is logged; encryption of connector credentials and MFA secrets at rest; hashed API-key and embed-token secrets.

**What cannot be claimed:** any retention period; immutability or tamper evidence; complete coverage of deletions, revocations or denied requests; login, password or MFA event history; erasure of personal data on request; enforcement of processing restrictions; SOC 2, ISO 27001, GDPR compliance, or any certification. None of these has been assessed or certified, and nothing in the repository suggests otherwise.

## 3. Data governance (brief §11.3)

| Topic | Current state | Recommendation |
|---|---|---|
| Ownership | Tenants own connectors and rows; no per-dataset owner or steward | Dataset owner field; owner approves sharing and export settings |
| Visibility | Any member with `analytics.view` can query every dataset in the tenant | Dataset-level permissions when customers ask for them (document 05) |
| Classification and PII | None; rows are schemaless | Field classification in the schema catalogue; masking in previews, exports and AI prompts |
| Retention | Not enforced (§1.2) | Tenant-configurable row retention per dataset; platform retention per log type |
| Export permissions | `analytics.export`, `reports.export` exist; viewer exports governed only by role | Per-dashboard "allow export" setting for viewers and embeds |
| Deletion | Connector delete leaves rows ({{CON:delete-cascade}}); tenant deletion missing ({{TEN:no-delete}}) | Verified cascades with purge evidence |
| Backups | No procedure in the repository (document 12) | Provider-level PITR plus documented, rehearsed restores |
| Lineage | None (document 06 §4) | `SyncRun` and `DatasetVersion` recorded on every result |
| AI provider data handling | Not applicable yet | Before AI ships: per-tenant consent; send schemas and aggregates, not raw rows; masked samples; provider retention configuration matched to customer commitments; record in vendor inventory (document 08 §5) |
| Third-party transfers | Data reaches the database host, Render, Vercel (SSR requests), the SMTP provider, S3 provider, Redis provider, Razorpay (billing data) and the frontend error reporter (document 15) | Maintain the vendor inventory with data categories and regions; list subprocessors publicly before claiming any compliance posture |

## 4. Two anomaly-detection systems (brief §12)

Business-data anomaly detection belongs to the tenant analytics product and is specified in document 08 §9. **Platform security anomaly detection** watches Analivo itself and is specified here. Today it consists only of per-account login lockout.

| Signal | Event source (exists?) | Initial rule | Severity |
|---|---|---|---|
| Repeated failed logins per account / per IP / per tenant | `LoginAttempt` (yes) | ≥ N failures in 15 min across ≥ M accounts from one IP (credential stuffing); ≥ N failures on one admin account | High for admin accounts |
| Admin login from new IP or country, or outside usual hours | Sessions with IP/user agent (yes) | First seen IP for an admin | Medium |
| Privilege changes | Audit events (yes, partial) | Any super-role grant; any self-targeted change attempt; role change outside change window | High |
| MFA disabled or re-enrolled | Needs a security event | Any occurrence for an admin | High |
| Impersonation | Support audit (yes) | Impersonation start; more than K per admin per day; impersonation into an admin-owned tenant | Medium |
| API-key misuse | Needs per-key request logging | Requests from new IP ranges; error-rate spike; use after revocation attempts | Medium |
| Abnormal request volume | Access log / rate-limit events | Rate-limit hits per tenant or key above baseline | Medium |
| Repeated authorization failures | Needs denied-request audit ({{GOV:audit-mw}}) | ≥ N 403s per actor in 10 min, especially cross-tenant 403s from `resolveTenant` | High |
| Unusual exports | Audit export events | Export volume above the actor's baseline; export by a newly granted role | Medium |
| Connector authentication failures | Connector `lastError` | Repeated auth failures per connector | Low |
| Resource consumption | Monitoring (placeholder today) | Query time or queue backlog above threshold per tenant | Medium |

Requirements: rules are versioned code with tests that replay synthetic event streams; detections create `SecurityAlert` records with severity, evidence links, status (`open`, `acknowledged`, `false_positive`, `resolved`) and owner; high-severity alerts notify an on-call channel; tuning and false-positive rates are reviewed monthly; alerts and evidence follow the audit retention policy. A detection is reported only when the underlying events and rule support it; anything else is a hypothesis for investigation.

## 5. Findings in this area

{{GOV:auditlog-scope}}, {{GOV:plugin-gaps}}, {{GOV:retention}}, {{GOV:redaction-gaps}}, {{GOV:redact-dates}}, {{GOV:audit-mw}}, {{GOV:impersonation-attribution}}, {{GOV:auth-events}}, {{GOV:no-security-detection}}, {{GOV:dsr}}, {{GOV:export-expiry}}, {{GOV:append-only}}, {{GOV:accesslog-gaps}}, {{GOV:log-redact}}. Full details are in `19-findings-register.md`.
