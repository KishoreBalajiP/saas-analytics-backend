# Analivo audit and implementation blueprint (2026-10-19)

**Scope:** complete product audit, enterprise architecture review, AI analytics blueprint, platform-administration review, security assessment and end-to-end implementation roadmap for Analivo (the `saas-analytics-backend` and `saas-analytics-frontend` repositories).

**Nature of this work:** audit and planning only. No application source, configuration, schema, data, deployment or external service was changed. The only writes are the documents in this folder (`backend/docs/audit-2026-10-19/`) plus installing dependencies from the lockfiles so that the existing test, lint, type-check and build scripts could be executed locally.

**Relationship to older reports:** the ~30 reports already in `backend/docs/` (phase plans, readiness audits, the 2026-10-16 discovery report) were treated as leads, not evidence. Where this audit contradicts them, this audit cites the code and the older document should be read as historical. See `03-feature-inventory-and-classification.md` section "Prior-report revalidation" and `19-findings-register.md` entries prefixed `DOC-`.

## Key conclusions

1. **The core tenant product does not work end to end in the audited commits.** Every gated workspace page shows "Permission required" to every tenant user, including owners, because the tenant profile returns no permissions ({{FE:perm-gate}}). Behind that gate, analytics results and dashboard widgets never render because of frontend/backend response-shape mismatches ({{FE:analytics-shape}}, {{FE:dashboard-shape}}). Whether production runs the same code is unverified and is the first item in the roadmap.
2. **Developer API and embedded analytics are broken**, contrary to earlier reports: API keys cannot be created ({{API:no-tenant}}), embed tokens cannot be minted or read ({{API:wrapper}}), and the same root cause leaves a latent cross-tenant read/modify/revoke path ({{TEN:apikey-idor}}).
3. **Privilege boundaries leak inside both planes.** Tenant Admins can invite Owners ({{TEN:invite-owner}}); revoked invitees can still get in ({{TEN:invite-revoke}}); admin listings return password hashes and MFA secrets ({{ADM:pwhash}}); admins can grant themselves the super role ({{ADM:self-escalate}}); MFA can be switched off with only an access token ({{AUTH:mfa-reenroll}}).
4. **Monetisation cannot be enforced.** A workspace route writes any plan without payment ({{BIL:free-upgrade}}), latent only because billing permissions were never seeded ({{BIL:perm-keys}}); subscriptions never expire ({{BIL:no-expiry}}); quotas count edits instead of resources and lock tenants out ({{BIL:quota-ops}}).
5. **The numbers can be wrong even when they render.** Date windows apply to ingestion time, which every sync resets ({{ANA:date}}); report exports are truncated to one page ({{ANA:report-truncated}}); unknown filters are silently dropped ({{ANA:silent-drop}}).
6. **Production safety nets are missing.** Declared indexes (and so every unique and TTL constraint) are never built in production ({{DB:indexes}}); there is no CI ({{OPS:no-ci}}), no backup or restore procedure ({{OPS:backups}}), no metrics or alerting ({{OPS:observability}}), and retention is a stub ({{GOV:retention}}).
7. **There is no AI capability yet**, and the public site correctly claims none ({{AI:none}}). Document 08 sets out how to add it safely once the engine's correctness problems are fixed.
8. **The foundations are worth keeping.** Separate user/admin token audiences with live session checks, refresh rotation with reuse detection, encrypted credentials, hashed key and token secrets, strict production configuration gates, a tenant-safe query engine, and substantial (if unautomated) test suites. The roadmap fixes and builds on these rather than replacing them.

## How to read this set

| # | Document | Answers |
|---|---|---|
| 00 | `README.md` (this file) | Method, evidence rules, legend, index |
| 01 | `01-repository-and-environment-baseline.md` | What was checked out, how it is built and configured, what the baseline commands returned |
| 02 | `02-architecture-and-integration-map.md` | How the backend, frontend and database fit together; request lifecycle; UI → API → DB map |
| 03 | `03-feature-inventory-and-classification.md` | Every product capability with its verified status label; revalidation of prior-report claims |
| 04 | `04-product-journeys-and-failure-recovery.md` | End-to-end journeys (5.1–5.9 of the brief) and what happens when each step fails |
| 05 | `05-roles-personas-and-permission-matrix.md` | Current roles vs. the target persona model; permission matrix; migration risks |
| 06 | `06-connectors-datasets-and-query-engine.md` | Connector inventory, BYOD, query safety, freshness and lineage |
| 07 | `07-dashboards-visualization-and-reports.md` | Dashboard lifecycle, visualization correctness, reports and scheduling |
| 08 | `08-ai-analytics-blueprint.md` | Natural-language analytics, insights, auto-dashboards, health scoring, anomaly detection, AI evaluation |
| 09 | `09-embedded-analytics-and-developer-api.md` | API keys, external API, embed tokens, CORS and origin policy |
| 10 | `10-platform-admin-control-plane.md` | Admin authentication, admin lifecycle, platform dashboard, tenant management, configuration, support access |
| 11 | `11-governance-audit-and-compliance.md` | Audit logging, compliance centre, data governance, platform security anomaly detection |
| 12 | `12-operations-monitoring-and-incidents.md` | Health, logging, metrics, jobs, incident model, backups and recovery |
| 13 | `13-billing-plans-and-entitlements.md` | Plans, subscriptions, entitlements, quotas, Razorpay integration, reconciliation |
| 14 | `14-security-assessment.md` | Security findings with severity, exploitability, remediation and regression tests |
| 15 | `15-frontend-ux-and-product-coherence.md` | Public site, onboarding, tenant and admin UX, accessibility |
| 16 | `16-database-architecture-and-scalability.md` | Data model, tenant scoping, indexes, integrity, performance and scale |
| 17 | `17-testing-audit-and-regression-matrix.md` | Test inventory and quality, CI, the 20-scenario regression matrix |
| 18 | `18-product-research-and-opportunities.md` | Research notes and additional feature opportunities |
| 19 | `19-findings-register.md` | Every finding with the required fields and its verification verdict |
| 20 | `20-implementation-roadmap.md` | Phased plan with acceptance criteria, tests, dependencies and human approvals |
| 21 | `21-verification-log.md` | Every command executed, exit status, counts, and what was deliberately not run |

## Evidence rules used throughout

1. A claim about behaviour cites a file and line (`backend/src/...:NN` or `frontend/src/...:NN`). Line numbers refer to the commits named in document 01.
2. A route, model, UI page, mock, or passing unit test alone never establishes that a feature works end to end. Status labels are applied per capability, not per module.
3. Prior reports, `STATUS.md` files, README files and code comments are leads. Where they conflict with code, the code wins and the conflict is recorded as a `DOC-` finding.
4. Production behaviour was not probed. Anything that depends on deployed configuration is labelled **Unverified** or **Blocked by an external dependency** and listed as a staging verification step in document 20.
5. Secrets are never reproduced. Only variable names are cited. The committed test-output files at the backend root were scanned for credential patterns; presence, not content, is reported.
6. Findings carry one of these verdicts: **CONFIRMED** (observation re-checked against the cited code by a second, adversarial pass), **PLAUSIBLE** (observed but one verifier disagreed on severity or scope), **UNVERIFIED** (low severity or product gap, not independently re-checked), **REFUTED** findings were dropped and are not listed.

## Status labels

| Label | Meaning as used here |
|---|---|
| Implemented and verified | Code path exists and a real test that exercises it (read, not just counted) exists and passes in the local baseline run |
| Implemented but incompletely verified | Code path exists; tests cover part of it or only the happy path; or verification depends on a provider not exercised locally |
| Partially implemented | Some of the workflow exists; a required step is missing or stubbed |
| Broken | Code path exists but a defect prevents the intended outcome |
| Missing | No implementation found |
| Planned or documented only | Only documentation, roadmap or placeholder exists |
| Mocked or simulated | Returns synthetic or placeholder data, or a no-op stub |
| Blocked by an external dependency | Needs a provider, credential or environment not available to this audit |
| Unverified | Could not be established from the repository alone |

## Finding identifiers

`AUTH-`, `TEN-` (tenancy/RBAC), `CON-` (connectors/jobs), `ANA-` (analytics/dashboards/reports/alerts), `AI-`, `API-` (API keys/embed), `ADM-` (platform admin), `GOV-` (audit/compliance), `BIL-`, `SEC-`, `FE-`, `OPS-`, `DB-`, `TST-`, `DOC-`. Numbers are stable within this audit; cross-references use the ID.

## Environment note

The assignment brief named Windows paths (`D:\saas-analytics-platform\backend` and `\frontend`). The audited checkouts live on macOS at `/Users/josephremingstonl/Downloads/code/saas-analytics-backend` and `/Users/josephremingstonl/Downloads/code/saas-analytics-frontend`. All relative paths in these documents are written as `backend/...` and `frontend/...` so they resolve against either layout.
