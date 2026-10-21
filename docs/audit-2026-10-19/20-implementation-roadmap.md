# 20. Implementation roadmap

**Audience:** the engineering lead and product owner planning the work that follows this audit.

**How to read this plan.** Work is ordered by dependency and risk, not by feature appeal. Each phase has an exit gate; a phase is complete when its gate passes, not when its tickets close. Sizes are relative (**S** under a week, **M** one to three weeks, **L** more than three weeks of one engineer's time) and are estimates, not commitments. Finding IDs refer to `19-findings-register.md`. Items marked **[approval]** need a named human decision or a production change that this audit did not make.

## Guiding rules for every phase

1. Every fix ships with the regression test named in its finding, running in CI.
2. No feature is labelled available in the UI, docs or marketing until its exit criteria pass on staging.
3. Production changes (index builds, data migrations, secret rotation, permission seeding) go through a written runbook with a dry run on a copy of production data **[approval]**.
4. Tenant isolation, authorisation and monetisation defects take precedence over everything else.

## Phase 0: establish the truth and stop the bleeding

**Goal:** know what production runs, put CI in place, and fix the defects that either break the core product or expose data or money.

| # | Work item | Findings | Size |
|---|---|---|---|
| 0.1 | **Production fact-finding (read-only) [approval]:** deployed commit SHAs on Render and Vercel; `NODE_ENV` and other non-secret config values; index list per collection; counts of `ApiKey`, `EmbedToken`, scoped admins and scoped admin roles; whether billing permissions were seeded; server-side JavaScript setting; database backup/PITR status; Render instance count and egress rules. A signed-in walkthrough of register → upload → query → dashboard on production | {{OPS:indexes}}, {{FE:perm-gate}}, {{OPS:backups}} | S |
| 0.2 | **CI in both repositories:** backend guards + tests (pinned Node LTS via `.nvmrc`/`engines`), frontend typecheck + lint + tests + build; required on `main`. Fix the three environment-dependent test failures first | {{OPS:no-ci}}, {{TST:env-tests}} | S |
| 0.3 | **Unblock the tenant workspace:** return roles and permissions from `/users/me` and `/auth/me`; align the two frontend permission helpers; fix analytics and dashboard response shapes with contract tests; clear the query cache on sign-out | {{FE:perm-gate}}, {{FE:analytics-shape}}, {{FE:dashboard-shape}}, {{FE:query-cache}}, {{FE:home-error}} | M |
| 0.4 | **Close platform-admin holes:** projection that strips secrets from admin reads; block self-targeted privilege changes and add a role ceiling; refuse MFA re-enrol when enabled and require step-up to disable; fix admin MFA sign-in in the UI; deny `pending`/`locked` admins | {{ADM:pwhash}}, {{ADM:self-escalate}}, {{ADM:self-patch}}, {{AUTH:mfa-reenroll}}, {{FE:admin-mfa}}, {{AUTH:pending-admin}} | M |
| 0.5 | **Close tenant privilege holes:** invitation role by id with ceiling; invited users cannot log in or reset until acceptance; revoke removes provisional grants; permission gate on `/users` | {{TEN:invite-owner}}, {{TEN:invite-revoke}}, {{TEN:users-ungated}} | M |
| 0.6 | **Tenant context on API keys and embed tokens:** mount tenant resolution, pass `req.tenant.id`, and make tenant-scoped repositories throw on a missing tenant id; add cross-tenant HTTP tests | {{TEN:apikey-idor}}, {{API:no-tenant}} | S |
| 0.7 | **Billing lockdown before seeding billing permissions:** remove direct plan writes and reactivate from workspace routes; then seed `iam.subscriptions.*`, `iam.entitlements.*`, `billing.*` **[approval]** | {{BIL:free-upgrade}}, {{BIL:perm-keys}} | S |
| 0.8 | **Index provisioning:** a migration step that runs `syncIndexes` with a reviewed diff; resolve any existing duplicates first **[approval]** | {{OPS:indexes}} | S–M |
| 0.9 | **Config hardening:** `EMBED_CORS_ALLOW_ALL=false` default; pin `NODE_ENV=production` in a `render.yaml`; separate development credentials from production and rotate any production secret that lived in a developer `.env` **[approval]** | {{API:cors-default}}, {{OPS:node-env}}, {{OPS:dev-creds}} | S |
| 0.10 | **Stop the alert storm:** validate cron on save; compute next evaluation before side effects | {{ANA:alert-cron}} | S |
| 0.11 | **Repository hygiene:** remove the committed test-output files; mark older reports in `docs/` as historical and point readers to this audit | {{SEC:test-logs}}, {{DOC:status-drift}} | S |

**Exit gate:** CI green on both repositories; a new tenant can register, upload a CSV, run a query, see a dashboard render data, and invite a member with the correct role on staging; no admin read returns a secret; cross-tenant tests for keys and embeds pass; production index list matches the models; the 0.1 facts are recorded in this folder.

## Phase 1: correctness and isolation foundations

**Goal:** the numbers are right, the boundaries are enforced in one place, and background work is reliable.

| # | Work item | Findings | Size |
|---|---|---|---|
| 1.1 | **Strict query contract** shared by analytics, widgets, reports, alerts and the external API; reject instead of drop; `maxTimeMS`; per-tenant query concurrency; numeric `$convert` | {{ANA:expr}}, {{ANA:silent-drop}}, {{ANA:tostring}}, {{AI:groupby}}, {{AI:strict}} | M |
| 1.2 | **Business time:** `dateRange.field` on a typed date column; tenant time zone on presets and cron; relative presets stored as presets | {{ANA:date}}, {{ANA:timezone}}, {{ANA:frozen-presets}}, {{ANA:report-overrides}} | M |
| 1.3 | **Quotas count resources, not operations;** metered usage per period; reconciliation | {{BIL:quota-ops}}, {{CON:quota}}, {{ANA:quota}}, {{BIL:soft-limits}}, {{CON:storedrows}}, {{BIL:api-calls}} | M |
| 1.4 | **Durable jobs:** separate worker service; BullMQ in production; job schedulers or distributed cron with atomic claims; `JobRun`/`SyncRun` records; reaper for stale runs; graceful drain | {{OPS:cron}}, {{ANA:sched-dup}}, {{CON:cron-lock}}, {{CON:wedge}}, {{CON:stale-dead}}, {{CON:shutdown}}, {{OPS:shutdown}}, {{OPS:single-process}} | L |
| 1.5 | **Reports and alerts correctness:** full-result artefacts; real XLSX; alert metric extraction; cooldown advances evaluation; analytics export worker | {{ANA:report-truncated}}, {{ANA:alert-metric}}, {{ANA:cooldown}}, {{ANA:export-broken}} | M |
| 1.6 | **Lifecycle cascades:** connector deletion purges rows and caches and disables dependants; tenant suspension blocks keys, embeds, schedules and webhooks at request time | {{CON:delete-cascade}}, {{API:suspension}}, {{ADM:suspend-cascade}} | M |
| 1.7 | **Connector safety:** egress policy for database connectors; URI option allow-list; generic errors; timeouts and row caps for every provider; streaming XLSX; upload validation and proper 413/415 | {{CON:ssrf}}, {{CON:mongo-timeouts}}, {{CON:xlsx}}, {{CON:upload}} | M |
| 1.8 | **Webhook integrity:** sign `timestamp.body`, require timestamps, cheap pre-checks before key derivation | {{SEC:webhook-replay}}, {{CON:webhook-scrypt}} | S |
| 1.9 | **Auth hardening:** refresh token out of the body; separate cookie names per portal; per-route Redis-backed rate limits; lockout decay; logout revokes by token; multi-tab refresh coordination; absolute session lifetime; expiry-aware role resolution | {{AUTH:refresh-in-body}}, {{FE:cookie-name}}, {{AUTH:rate-limit}}, {{AUTH:lockout-rearm}}, {{AUTH:logout-noop}}, {{AUTH:multitab}}, {{SEC:role-expiry}} | M |
| 1.10 | **Caching coherence:** dataset version in cache keys | {{ANA:cache}} | S |
| 1.11 | **Shared frontend/backend contract:** generated types or OpenAPI; contract tests against a real backend in CI; replace mocked transport tests for the main journeys | {{FE:tests-mocked}}, {{TST:mocked-contracts}} | M |
| 1.12 | **Idempotency:** mount the middleware with keys scoped by actor and tenant, or remove it and the client header | {{OPS:idempotency}} | S |

**Exit gate:** documented query contract with tests for every rejection rule; scheduled reports and alerts run once per tick with two instances running; a killed worker mid-sync leaves no wedged connector; a 3-year CSV answers "last month" correctly in the tenant's time zone; quota tests (create/update/delete/concurrent) pass.

## Phase 2: platform administration, governance and operations

| # | Work item | Findings | Size |
|---|---|---|---|
| 2.1 | **Platform role model:** Super, Platform, Support, Auditor roles with distinct grants; migrate existing admins **[approval]**; apply `tenantScope` everywhere; permission keys for access-request approval and master data | {{TEN:platform-roles}}, {{TEN:support-scope}}, {{GOV:auditlog-scope}}, {{TEN:access-approval}}, {{ADM:masterdata}}, {{ADM:me-scope}}, {{ADM:revoke-scoped}} | M |
| 2.2 | **Admin authentication completeness:** MFA required for privileged roles; recovery codes; admin-assisted reset; admin invitation acceptance; working admin password reset page; step-up for sensitive actions | {{AUTH:no-recovery-codes}}, {{ADM:invite-flow}}, {{AUTH:admin-reset-link}} | M |
| 2.3 | **Support access redesign:** sanitised diagnostics first; consented, time-boxed, read-only impersonation with operator attribution and atomic caps; fix support UI | {{ADM:impersonation}}, {{ADM:cap-bypass}}, {{GOV:impersonation-attribution}}, {{ADM:support-ui}} | M |
| 2.4 | **Platform configuration surfaces:** settings, feature flags and email templates over HTTP with validation, audit, history and rollback; secret settings behind their own permission | {{ADM:config-501}}, {{ADM:secrets}} | M |
| 2.5 | **Audit and security events:** `securityEvent()` for auth/MFA/permission/support; capture deletes and bulk updates; allow-list redaction; insert-only audit credentials and signed digests; request-level denied-request audit | {{GOV:auth-events}}, {{GOV:plugin-gaps}}, {{GOV:redaction-gaps}}, {{GOV:redact-dates}}, {{GOV:append-only}}, {{GOV:audit-mw}} | M |
| 2.6 | **Security detection rules** (document 11 §4) with alerting and acknowledgement | {{GOV:no-security-detection}} | M |
| 2.7 | **Retention and exports:** real cleanup job per collection; export expiry; outbox for email | {{GOV:retention}}, {{OPS:retention}}, {{GOV:export-expiry}} | M |
| 2.8 | **Observability:** readiness that reflects dependencies; metrics, traces and error aggregation for both repositories; request id surfaced in the UI; alerts; on-call runbooks; status page | {{OPS:observability}}, {{OPS:degraded}}, {{OPS:monitoring-500}}, {{OPS:request-id}}, {{OPS:tokens-logged}} | M |
| 2.9 | **Backups and recovery:** confirm PITR; quarterly restore drill with evidence; tenant export **[approval]** | {{OPS:backups}} | S–M |
| 2.10 | **Tenant member and role management** API and UI; ownership transfer done properly; tenant deletion with verified purge | {{TEN:no-member-mgmt}}, {{TEN:ownership}}, {{TEN:no-delete}} | M |
| 2.11 | **Compliance processors:** real erasure, enforced restrictions, owner-only DSR filing | {{GOV:dsr}} | M |

**Exit gate:** every admin action passes the permission matrix tests in document 05; a restore drill has been completed and recorded; security alerts fire on synthetic credential-stuffing and privilege-change streams; retention removes data on schedule with a report.

## Phase 3: complete the promised product

| # | Work item | Findings | Size |
|---|---|---|---|
| 3.1 | **Billing model decision [approval]**, then expiry and renewal, provider-confirmed upgrades only, `x-razorpay-event-id` dedupe, safe capture application, reconciliation fixes, feature entitlements middleware, pricing page and quota UX | {{BIL:no-expiry}}, {{BIL:lost-payments}}, {{BIL:features}}, {{BIL:default-starter}}, {{BIL:regex}}, {{BIL:reconcile-hol}}, {{BIL:authorized}}, {{BIL:catalogue-seed}}, {{BIL:no-recurring}}, {{BIL:frontend}} | L |
| 3.2 | **Embedding rebuilt** on signed, origin-bound embed sessions and an iframe page; public share links with allow-listed payloads | {{API:wrapper}}, {{API:embed-leak}}, {{API:token-in-url}}, {{API:preflight}}, {{API:no-embed-product}}, {{API:preview-contract}} | L |
| 3.3 | **Developer API:** key lifecycle with rotation and expiry caps, per-key Redis limits and metering, error codes, OpenAPI reference and examples, frontend fixes | {{API:metering}}, {{API:limiter-order}}, {{API:audit-noise}}, {{API:500s}}, {{API:list-contract}}, {{FE:key-prefix}}, {{API:no-tests}} | M |
| 3.4 | **Scheduled delivery** via outbox with recipients, retries and history | {{ANA:no-delivery}} | M |
| 3.5 | **Visualization spec and widget builder;** sharing implemented or removed | (document 07 §2) | M |
| 3.6 | **Onboarding polish:** registration form validation and truthful messages; slug shown and remembered; webhook absolute URLs; settings and profile pages real or hidden; legal pages and consent **[approval: legal review]** | {{FE:register-form}}, {{FE:slug}}, {{FE:webhook-url}}, {{FE:settings-placeholder}}, {{FE:legal}}, {{FE:headers}} | M |
| 3.7 | **Datasets:** schema catalogue and column confirmation, key column, replace mode, lineage display | {{AI:schema}}, {{CON:no-job-history}}, {{CON:advertised}} | M |

**Exit gate:** a customer can embed a dashboard on their own site with locked filters and revoke it; an integrator can create a key, call the API with documentation alone, and see their usage; a scheduled report is delivered and its history visible; a paid upgrade happens only after confirmed payment and lapses when unpaid.

## Phase 4: intelligence and enterprise

Follow document 08's phases A1–A6 (catalogue and metric definitions, natural-language questions with validated plans, insights with claim checking, anomaly detection, health scorecards, starter dashboards) and the Tier 2 enterprise items in document 18 (tenant-user MFA, SSO/SCIM, audit streaming, dataset- and row-level permissions, connector expansion). Each AI phase has its own exit criteria in document 08 §13; none should start before Phase 1 items 1.1 and 1.2 are complete.

## Verification steps that need production or external access

| Check | Owner | When |
|---|---|---|
| Deployed commit parity and a signed-in production walkthrough | Engineering lead | Phase 0 |
| Production index list and duplicates report | Database owner | Phase 0 |
| SMTP delivery for verification, reset and invitation emails (to a test mailbox) | Engineering | Phase 0 |
| Razorpay test-mode checkout, webhook signature, duplicate and out-of-order delivery | Billing owner | Phase 3 |
| MongoDB connector against a containerised source and an egress-denied target | Engineering | Phase 1 |
| Restore drill from backup into a scratch cluster | Operations | Phase 2 |
| Load test: 10 MB CSV sync, 30-widget dashboard, 50 concurrent users per tenant, two app instances | Engineering | End of Phase 1 |
| Browser matrix for session restore with third-party cookies blocked (Safari, Brave) | Frontend | Phase 1 |
| Accessibility audit with axe and a screen reader on the main journeys | Frontend | Phase 3 |
