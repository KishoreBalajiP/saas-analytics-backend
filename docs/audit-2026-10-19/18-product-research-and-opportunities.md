# 18. Product research and additional feature opportunities

**Audience:** product leadership deciding what to build after the corrective work in document 20.

**Principle.** Every opportunity below is ranked after the defects in `19-findings-register.md`. Several of today's surfaces (embedding, developer API, scheduled delivery, admin configuration) are advertised by the code or UI but not functional; making them work is worth more than adding new surfaces. Opportunities are chosen because they compound on foundations the audit recommends anyway (typed schemas, metric definitions, durable jobs, a real embed model), not because a competitor has them.

## 1. What comparable products establish as baseline

| Pattern | Reference | Implication for Analivo |
|---|---|---|
| Governed metric definitions sit between users (and AI) and raw data | dbt Labs' 2026 benchmark found models answered more accurately through a semantic layer than by generating SQL directly; the authors are a semantic-layer vendor, so treat exact figures as indicative | Build metric definitions before natural-language features (document 08 §4.3) |
| Embeds are minted server-side as short-lived signed tokens that name the resource and lock filter values | Metabase static embedding; Superset guest tokens with row-level rules and allowed origins | Replace bearer embed links with signed, origin-bound sessions (document 09 §2) |
| Anomaly detection chooses its method by history length and seasonality | StarTree ThirdEye's algorithm guidance; Dynatrace seasonal baselines; Sling's minimum-history gate | Ship a history-aware detector with an explicit "not enough data" state (document 08 §9) |
| Webhooks are at-least-once and may arrive out of order | Razorpay webhook documentation (dedupe on `x-razorpay-event-id`, respond within 5 s, retries for 24 h) | The same discipline applies to Analivo's inbound connector webhooks and any outbound webhooks it offers |
| Recurring jobs need single-producer scheduling plus idempotent handlers | BullMQ Job Schedulers; node-cron distributed mode; Render cron's one-active-run guarantee | Durable scheduler design (document 12 §2) |

## 2. Opportunities, ranked

Size: **S** ≈ under two engineer-weeks, **M** ≈ two to six, **L** ≈ more than six. Sizes are rough and assume the prerequisite phases in document 20 are complete.

### Tier 1: complete the product that is already promised

| # | Opportunity | User value | Depends on | Size |
|---|---|---|---|---|
| 1 | **Metric definitions** (named, versioned, approved metrics with unit, format and direction) | Consistent numbers across dashboards, reports, alerts and AI; the foundation for health scorecards | Strict query validation, schema catalogue | M |
| 2 | **Data freshness and lineage in the UI** ("data as of", last sync status, which dataset version a number came from) | Trust in displayed numbers; faster support diagnosis | `SyncRun`/`DatasetVersion` (document 06 §4) | M |
| 3 | **Real scheduled delivery** (email first, then Slack/Teams and outbound webhooks) with delivery history | Reports reach people without logging in | Outbox, durable scheduler, report completeness fixes | M |
| 4 | **Signed iframe embedding with an embed SDK** (resize, theme, filter events) and per-tenant embed configuration | The core "embedded analytics" promise | Document 09 §2 | L |
| 5 | **Developer portal**: OpenAPI reference, examples, test-mode keys, per-key usage | Integrators can self-serve | Fixed API-key surface | M |
| 6 | **Visual widget builder** replacing the JSON textarea | Non-technical users can build dashboards | Visualization spec, shared query contract | M |

### Tier 2: enterprise readiness

| # | Opportunity | User value | Depends on | Size |
|---|---|---|---|---|
| 7 | **Tenant-user MFA** (TOTP first, WebAuthn later) and an MFA-required tenant policy | Baseline security expectation; listed as missing on the public site | Auth hardening (AUTH findings) | M |
| 8 | **SSO (OIDC/SAML) and SCIM provisioning** | Enterprise identity integration; automatic deprovisioning | Role model migration (document 05 §5); `User.ssoSubject` index already exists | L |
| 9 | **Audit-log streaming** (webhook or SIEM connector) and tenant-visible audit history | Customers' security teams can monitor their own workspace | Security events and redaction fixes (document 11) | M |
| 10 | **Dataset- and row-level permissions** (dataset grants; user attributes mapped to row filters, reusable as locked embed filters) | Share one workspace across teams or customers safely | Metric definitions, embed model | L |
| 11 | **Dashboard versioning and restore** | Safe collaboration and recovery from mistakes | — | M |
| 12 | **Usage and cost transparency** for tenants (queries, storage, API calls, AI questions against plan limits) | Fewer billing surprises; supports upsell | Correct quota accounting (BIL/ANA/CON findings) | S–M |
| 13 | **Connector expansion**: Google Sheets, PostgreSQL/MySQL (read-only), BigQuery, generic REST pull | Bring more data without CSV exports | Job model, egress policy, schema catalogue | L (per connector M) |

### Tier 3: intelligence and differentiation (after Tier 1)

| # | Opportunity | User value | Depends on | Size |
|---|---|---|---|---|
| 14 | **Ask-a-question** natural-language analytics with visible plan and provenance | Faster answers for non-analysts | Document 08 phases A0–A2 | L |
| 15 | **Insight digests** (weekly "what changed" email with top movers and anomalies) | Proactive value without logging in | Delivery pipeline, insights computations, anomaly detector | M |
| 16 | **Business health scorecards** with targets and explanations | Executive summary grounded in agreed metrics | Metric definitions | M |
| 17 | **Starter dashboards and templates** by data shape (orders, subscriptions, web traffic) | Faster time to first value in onboarding | Schema catalogue, deterministic generator | M |
| 18 | **Annotations and comments on charts** (deploys, campaigns, incidents) | Context for changes; feeds insight explanations | — | S–M |
| 19 | **Goals and targets on metrics** with progress tracking | Ties analytics to decisions | Metric definitions | S |

### Tier 4: later or conditional

| # | Opportunity | Condition to pursue |
|---|---|---|
| 20 | Data residency per tenant | A customer contract requires it; needs multi-region infrastructure |
| 21 | White-label and custom domains for embeds | Embedding demand proven by Tier 1 #4 |
| 22 | Customer-managed encryption keys | Enterprise security requirement; the encryption utility has a KMS swap point but key rotation is not implemented |
| 23 | Pre-aggregated or materialised metrics for large datasets | Load tests show aggregation latency limits (document 16) |
| 24 | SQL or notebook mode for analysts | Strong analyst demand; would need a different execution engine and a separate security review, so not recommended now |

## 3. Onboarding improvements with outsized impact

The registration-to-first-insight journey (document 04) has the most leverage on activation. Low-cost improvements once the defects are fixed:

1. A **sample dataset** available on day one so a new workspace can see a populated dashboard before connecting data.
2. An **onboarding checklist** persisted server-side (connect data → confirm columns and date field → first dashboard → invite a teammate → schedule a report).
3. **Column confirmation** after the first upload (types, business date, key column) feeding the schema catalogue.
4. A **starter dashboard** generated from that confirmation (Tier 3 #17).

## 4. What not to build yet

- An AI chat surface before metric definitions, strict validation and business-date semantics exist (it would produce confident, wrong answers).
- More connectors before the job model, quotas and deletion cascades are fixed.
- Compliance marketing (SOC 2, ISO 27001, GDPR) before the controls in document 11 exist and an assessment has been done.
- A second authentication system for admins; the existing audience separation is sound and only needs hardening.

## Sources

- dbt Labs, "Semantic layer vs. text-to-SQL (2026)": https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026
- Metabase static embedding: https://www.metabase.com/docs/latest/embedding/static-embedding
- Apache Superset embedding: https://superset.apache.org/user-docs/using-superset/embedding
- StarTree ThirdEye anomaly detection algorithms: https://docs.startree.ai/thirdeye/concepts-data-alerts-notifications/concepts-anomaly-detection-algorithms
- Razorpay webhook validation and best practices: https://razorpay.com/docs/webhooks/validate-test/ and https://razorpay.com/docs/webhooks/best-practices/
- BullMQ Job Schedulers: https://docs.bullmq.io/guide/job-schedulers
