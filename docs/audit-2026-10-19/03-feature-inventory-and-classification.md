# 03. Feature inventory and classification

**Audience:** anyone who needs a one-page answer to "what does Analivo actually do today?", including product, sales and engineering leads.

Each capability from the brief (§1.1) is classified with the labels defined in `README.md`. A capability is "Implemented and verified" only if code exists **and** a test that exercises the behaviour was read and passes. Where a backend capability works but the user interface cannot reach it, the end-to-end status is the lower of the two. All statements describe the audited commits; production may differ (document 20, item 0.1).

## 1. Summary

| Area | End-to-end status | One-line reason |
|---|---|---|
| Public website | Implemented but incompletely verified | Honest claims; no pricing, docs or real legal pages |
| Registration, verification, onboarding | Implemented but incompletely verified | Works through verification; concurrency relies on indexes production never builds; slug confusion at sign-in |
| Sign-in, sessions, password recovery (tenant) | Implemented and verified (backend) / Partially implemented (UI) | Strong backend; UI session handling has several defects |
| Platform admin authentication | Partially implemented | Admin MFA sign-in broken in the UI; MFA can be disabled by re-enrolment; admin reset link broken |
| Tenant workspace (datasets, analytics, dashboards, reports, alerts) | **Broken** in the UI | Every gated page shows "Permission required"; analytics and dashboard results never render |
| Membership, invitations, roles | Partially implemented | Invitations work but allow Owner escalation; no member or role management |
| Data connectors | Partially implemented | CSV and webhook real and tested; XLSX and MongoDB untested; Google Sheets and others absent |
| Query engine | Implemented but incompletely verified | Tenant-safe, but date semantics wrong, validation shallow, no limits |
| Dashboards and visualization | Partially implemented | Backend persistence verified; UI rendering broken; visualization config ignored |
| Reports and scheduled delivery | Partially implemented | Runs stored but truncated; never delivered |
| Alerts | Partially implemented | Threshold alerts work in tests; cron, metric and cooldown defects |
| AI analytics (NL, insights, auto-dashboards, health score) | **Missing** | No code |
| Business anomaly detection | Planned or documented only | Stub job |
| API keys and external API | **Broken** | Keys cannot be created; latent cross-tenant access |
| Embedded analytics | **Broken** | Token minting and public read always fail |
| Billing, plans, entitlements | **Broken** | Free plan change path, never-expiring subscriptions, operation-counting quotas, unseeded permissions |
| Platform admin control plane | Partially implemented | Real core; secret leakage, self-escalation, 501 configuration surfaces |
| Platform security monitoring | Missing | Login lockout only |
| Audit logs, governance, compliance | Partially implemented | Real trail with coverage, redaction and retention gaps |
| Operations, monitoring, recovery | Partially implemented | Liveness only; no metrics, alerts, backups procedure or CI |
| Testing | Implemented but incompletely verified | Large suites, not automated, missing the broken areas |

## 2. Detailed inventory

### 2.1 Identity, tenancy and access

| Capability | Status | Evidence / document |
|---|---|---|
| Self-service registration (tenant + owner + verification token) | Implemented but incompletely verified | `tests/self-service-registration.integration.test.js`; concurrent test failed in baseline (doc 17) |
| Email verification and resend | Implemented and verified | Same suite; 15-minute link lifetime |
| Tenant login with lockout and enumeration protection | Implemented and verified | `tests/auth-flow.integration.test.js` |
| Refresh rotation with reuse detection | Implemented and verified | `auth-flow.integration.test.js:158-201` |
| Logout | Partially implemented | Bearer-only logout revokes nothing ({{AUTH:logout-noop}}) |
| Tenant password reset | Implemented and verified (backend) | `password-reset-session.integration.test.js` |
| Tenant-user MFA | Missing | |
| Admin login with TOTP | Implemented and verified (backend) / Broken (UI) | {{FE:admin-mfa}} |
| Admin MFA disable/recovery | Broken / Missing | {{AUTH:mfa-reenroll}}, {{AUTH:no-recovery-codes}} |
| Admin password reset end to end | Broken | {{AUTH:admin-reset-link}} |
| Tenant isolation on core data routes | Implemented and verified | Engine tenant `$match`; dashboard/report HTTP isolation tests |
| Tenant isolation on API keys and embed tokens | Broken | {{TEN:apikey-idor}} |
| Default tenant roles (Owner, Admin, Manager, Viewer) | Implemented and verified | Seeded at onboarding |
| Tenant member and role management | Missing | {{TEN:no-member-mgmt}} |
| Invitations | Partially implemented | {{TEN:invite-owner}}, {{TEN:invite-revoke}} |
| Ownership transfer | Partially implemented | {{TEN:ownership}} |
| Workspace switching | Missing | |
| Workspace settings | Planned or documented only | 501 |
| Tenant deletion and export | Missing | {{TEN:no-delete}} |

### 2.2 Data and analytics

| Capability | Status | Evidence / document |
|---|---|---|
| CSV connector | Implemented and verified | Doc 06 |
| XLSX connector | Implemented but incompletely verified | No tests |
| MongoDB connector | Implemented but incompletely verified | No tests; SSRF ({{CON:ssrf}}) |
| Inbound webhook connector | Implemented and verified | HMAC tests; replay protection ineffective ({{SEC:webhook-replay}}) |
| Google Sheets, SQL databases, REST pull, warehouses | Missing / Planned or documented only | Doc 06 §1 |
| Schema discovery and typing | Partially implemented | Names only; {{AI:schema}} |
| Scheduled refresh | Missing | |
| Sync job visibility and recovery | Partially implemented / Broken | {{CON:no-job-history}}, {{CON:wedge}} |
| Dataset deletion cascade | Missing | {{CON:delete-cascade}} |
| Query engine (filters, grouping, metrics, pagination) | Implemented but incompletely verified | Doc 06 §3 |
| Business-date filtering and time buckets | Missing | {{ANA:date}}, {{AI:bucketing}} |
| Query limits (time, size, concurrency) | Missing | {{ANA:expr}} |
| Analytics page in the UI | Broken | {{FE:perm-gate}}, {{FE:analytics-shape}} |
| Analytics async export | Broken | {{ANA:export-broken}} |
| Dashboards CRUD, publish, duplicate (API) | Implemented and verified | Doc 07 |
| Dashboard viewing in the UI | Broken | {{FE:dashboard-shape}} |
| Visualization configuration | Partially implemented | Stored, ignored by renderer |
| Dashboard sharing | Planned or documented only | `shares` not enforced |
| Reports (CRUD, run, download) | Implemented but incompletely verified | Truncated artefacts ({{ANA:report-truncated}}) |
| Scheduled report delivery | Missing | {{ANA:no-delivery}} |
| Threshold alerts | Implemented but incompletely verified | {{ANA:alert-cron}}, {{ANA:alert-metric}} |
| In-app notifications | Implemented and verified | |
| Notification preferences | Mocked or simulated | |

### 2.3 Intelligence

| Capability | Status | Evidence / document |
|---|---|---|
| Natural-language analytics | Missing | {{AI:none}} |
| AI-generated insights | Missing | Doc 08 |
| Automatic dashboard generation | Missing | {{AI:autodash}} |
| Business health scoring | Missing | Doc 08 §10 |
| Business-data anomaly detection | Planned or documented only | {{AI:anomaly-stub}} |
| AI evaluation and observability | Missing | {{AI:observability}} |

### 2.4 Developer and embedding

| Capability | Status | Evidence / document |
|---|---|---|
| API key management | Broken | {{API:no-tenant}} |
| External dataset API | Implemented but incompletely verified (unreachable) | Doc 09 |
| External dashboard read | Broken | {{API:wrapper}} |
| Embed token minting and public read | Broken | {{API:wrapper}} |
| Embed origin binding, iframe artefact, SDK | Missing | {{API:no-embed-product}} |
| Integrator documentation | Missing | |

### 2.5 Monetisation

| Capability | Status | Evidence / document |
|---|---|---|
| Plan catalogue | Implemented but incompletely verified | Not auto-seeded ({{BIL:catalogue-seed}}) |
| Workspace billing self-service | Broken | Permissions never seeded ({{BIL:perm-keys}}); free plan change ({{BIL:free-upgrade}}) |
| Razorpay one-time checkout | Implemented but incompletely verified | Not exercised against Razorpay |
| Razorpay webhook signature | Implemented and verified | `tests/razorpay-billing.test.js` |
| Subscription periods, renewals, trials | Missing / Planned | {{BIL:no-expiry}}, {{BIL:no-recurring}} |
| Feature entitlements | Missing | {{BIL:features}} |
| Quotas | Broken | {{BIL:quota-ops}} |
| Reconciliation | Partially implemented | {{BIL:reconcile-hol}} |
| Pricing page | Missing | |

### 2.6 Platform operations and governance

| Capability | Status | Evidence / document |
|---|---|---|
| Admin lifecycle (create, update, suspend, restore, roles) | Implemented and verified, with defects | {{ADM:pwhash}}, {{ADM:self-escalate}} |
| Last-super-admin protection | Implemented and verified | Suspend and demote |
| Platform dashboard | Partially implemented | Placeholder health values ({{ADM:dashboard-metrics}}) |
| Tenant lifecycle | Implemented and verified (sessions only) | {{API:suspension}} |
| Access requests | Implemented and verified (backend) | {{TEN:access-approval}} |
| Support impersonation and tooling | Implemented and verified (backend) / Broken (UI) | {{ADM:impersonation}}, {{ADM:support-ui}} |
| Settings, feature flags, email templates | Planned or documented only | 501 ({{ADM:config-501}}) |
| Audit trail | Partially implemented | {{GOV:plugin-gaps}}, {{GOV:redaction-gaps}} |
| Audit export | Partially implemented | {{GOV:export-expiry}} |
| Compliance (data-subject requests) | Partially implemented | {{GOV:dsr}} |
| Retention | Planned or documented only | {{GOV:retention}} |
| Platform security anomaly detection | Missing | {{GOV:no-security-detection}} |
| Health and readiness | Partially implemented | {{OPS:degraded}} |
| Metrics, alerting, error aggregation | Missing / Mocked | {{OPS:observability}} |
| Backups and recovery | Planned or documented only | {{OPS:backups}} |
| Production index provisioning | Missing | {{DB:indexes}} |
| CI/CD | Missing | {{OPS:no-ci}} |

## 3. Revalidation of earlier claims (brief §3.4)

The 2026-10-16 discovery report and the earlier phase and readiness reports were treated as leads. Results of re-checking them against the current code:

| Earlier claim | Current finding |
|---|---|
| "Backend tests: 561 passed, 0 failures" | 560 of 561 passed on this machine (Node 26); the concurrent registration test fails because unique indexes are not awaited. Committed logs from 2026-10-12 also show 1–2 failures. Not reproducible as "0 failures" |
| "Frontend: 27 files, 244 tests passed; typecheck and build pass" | Typecheck and build pass; 242 of 244 tests pass on Node 26 |
| SEC-001: `EMBED_CORS_ALLOW_ALL=true` in `.env.example` | Still true, and the **code default** is also `true` (`env.js:214`). Lower practical impact today because embedding is broken |
| SEC-002: email, sheet-sync, cleanup, anomaly jobs are stubs | Still true. Additionally the stale-job recovery module is dead code that would crash on import |
| SEC-003: `/settings` returns 501 | Still true; `/feature-flags` and `/email-templates` are also 501. The frontend correctly shows "Coming soon" for settings |
| SEC-004: connector abstraction advertises more than exists | Mostly still true for documentation (Google Sheets, SQL, warehouses listed); the registry itself registers only CSV, XLSX, MongoDB and webhook |
| SEC-005: production configuration unverifiable | Still true; added: `NODE_ENV` not pinned by any deploy artefact and production indexes never built |
| SEC-006: connector outbound network controls not demonstrated | Confirmed as a defect: no egress controls at all ({{CON:ssrf}}) |
| SEC-007: React `act()` warnings; #418 not reproduced | Not re-tested in a browser; no new evidence either way |
| "API keys/external API: implemented, isolated path verified" | **Incorrect.** No test exercises them, key creation fails over HTTP, and by-id routes lack tenant scoping |
| "Embedding: implemented, not browser/prod verified" | **Incorrect.** Minting and public read always fail ({{API:wrapper}}) |
| "Dashboards/widgets: implemented, isolated path verified" | Backend yes; the UI never renders widget data ({{FE:dashboard-shape}}) |
| "Billing implemented with provider disabled by default" | Backend flows exist, but monetisation cannot be enforced (document 13) |
| "Every POST is idempotency-safe" (`AI_CONTEXT.md`) | Incorrect: the idempotency middleware is never mounted ({{OPS:idempotency}}) |
| "CI green" (`STATUS.md`, `CHANGELOG.md`) | There is no CI in either repository ({{OPS:no-ci}}) |
| Test counts 124 / 367 / 405 / 561 in various documents | Static count 561 backend, 239 frontend declarations; the documents contradict each other ({{DOC:status-drift}}) |
| "Phase 6 – implemented" (billing headers) vs `phase-6.md` "AI/ML, future" | Two numbering schemes; AI is not implemented |

**Documents safe to cite as current:** none of the pre-existing status documents. Use this folder; treat `backend/src/docs/STATUS.md`, `AI_CONTEXT.md`, the root `README.md`, `CHANGELOG.md` and everything else in `backend/docs/` as historical until updated.
