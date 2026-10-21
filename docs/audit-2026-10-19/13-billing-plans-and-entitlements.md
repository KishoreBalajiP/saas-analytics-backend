# 13. Billing, plans, quotas and entitlements

**Audience:** the business owner of monetisation and the engineers responsible for billing and plan enforcement.

**Verdict:** monetisation cannot be enforced today. The Razorpay integration has well-built pieces (signature verification over the raw body, server-side pricing, conditional transaction transitions), but the layers around it do not hold:

- **A paid plan can be obtained without paying.** `POST /tenants/:id/subscription/change-plan` writes any `planId` straight onto the subscription, with no payment, price or checkout check (`backend/src/services/subscription.service.js:219-262`), and `/subscription/reactivate` lifts an admin-imposed restriction ({{BIL:free-upgrade}}). It is guarded only by `iam.subscriptions.update`.
- **That permission is never seeded**, so on a fresh deployment every billing route returns 403 for every role ({{BIL:perm-keys}}). The obvious fix (seed the permission for Owners) would immediately expose the free-upgrade path, so the two must be fixed together.
- **Subscriptions never expire**: one payment grants a plan forever; cancellation and grace periods have no effect ({{BIL:no-expiry}}).
- **Plan features are never checked server-side** ({{BIL:features}}), and **quota counters count operations instead of resources**, so free tenants lock themselves out after a handful of edits ({{BIL:quota-ops}}).
- **A captured payment can be lost** when applying the plan fails after capture, or when a failed attempt precedes a successful one on the same order ({{BIL:lost-payments}}).

## 1. The five layers (brief §14)

### 1.1 Marketing plan descriptions

There is no public pricing page ({{BIL:frontend}}). The homepage makes no plan claims. Four default plans exist in the backend catalogue, but the catalogue is not auto-seeded and the seed endpoint needs a permission that is not seeded either ({{BIL:catalogue-seed}}). **Status: Missing.**

### 1.2 Application-side entitlement checks (frontend)

The workspace billing panel shows subscription, usage, features, a timeline and an upgrade action. There is no entitlement gating anywhere else in the UI and no handling of `QUOTA_EXCEEDED` responses, and the panel always labels Razorpay as test mode. **Status: Missing** for gating; **Implemented but incompletely verified** for the panel. Frontend checks are a convenience only; enforcement must be on the server.

### 1.3 Backend authorisation and quota enforcement

| Limit | Enforced where | Status | Problem |
|---|---|---|---|
| Members | Invitation create | **Broken** | Consumed on duplicates and resends, never released |
| Connectors | Connector create, **and** update, delete, every sync | **Broken** | Every operation consumes a unit; `release()` has no callers |
| Dashboards | Dashboard create, **and** update, delete, every widget create | **Broken** | as above; the free plan's limit of 5 is reached after a few edits |
| Reports / alerts | Create | **Partially implemented** | Consumed before validation; failures leak units |
| Scheduled reports | — | **Missing** | |
| Stored rows | Connector sync (estimated from bytes) | **Partially implemented** | Never reconciled; not applied to webhook ingestion |
| API requests (`apiCallsPerDay`) | API-key creation | **Broken** | Counted per key creation on a counter that never resets; external calls are unmetered |
| Datasets, queries, AI, storage, embeds | — | **Missing** | |
| Plan features (embed, SSO, scheduled reports, audit export, webhook connectors) | — | **Missing** | `entitlement.can()` exists but nothing calls it on these paths |
| Soft limits | `usage.service` | **Broken** | Behave as hard limits once exceeded ({{BIL:soft-limits}}) |
| Concurrency safety | `usageCounter.incrementOrCreate` + compensation | **Implemented and verified** | Atomic increment with compensating decrement; can briefly over-reject near the limit |
| Tenants with no subscription | `entitlement.service` | **Defect** | Fall back to the paid `starter` tier for free; `tenant.planId` is ignored ({{BIL:default-starter}}) |
| Plan lookup by code | `plan.service` | **Defect** | Unescaped, case-insensitive substring regex can match the wrong plan ({{BIL:regex}}) |

### 1.4 Billing-provider integration (Razorpay)

| Capability | Status | Notes |
|---|---|---|
| One-time order checkout + client verification | **Implemented but incompletely verified** | Server-side pricing; amount checked. Verification may mark an `authorized`-but-not-yet-captured payment as failed (hypothesis, {{BIL:authorized}}) |
| Webhook signature over raw body | **Implemented and verified** | `express.raw` for `/billing/webhook` (`backend/src/app.js:121`) |
| Webhook and transaction idempotency | **Implemented but incompletely verified** | Dedupe key is `event:entityId`, not Razorpay's `x-razorpay-event-id`, so multiple partial refunds on one payment collapse into one event |
| Recurring subscriptions, renewals, trials | **Planned or documented only** | One-time orders only; no renewal model ({{BIL:no-recurring}}) |
| Failed payment / dunning | **Partially implemented** | |
| Cancellation | **Partially implemented** | Recorded; no effect on access because periods are never enforced |
| Upgrade/downgrade proration and over-limit handling | **Missing** | |
| Admin checkout | **Broken** | Always 501 even when Razorpay is enabled |
| `RAZORPAY_ENABLED=false` behaviour | **Implemented but incompletely verified** | Noop provider returns 501 |
| Configuration hygiene | **Defects** | `RAZORPAY_ENVIRONMENT` is only a label (production accepts `test` and nothing checks it against the key); malformed plan mapping JSON silently becomes `{}`; the public `GET /billing/webhook/health` discloses provider state |
| Production configuration | **Unverified** | Not visible from the repository |

### 1.5 Billing history and reconciliation

The reconcile job exists, is disabled by default, and is head-of-line blocked by stale pending transactions ({{BIL:reconcile-hol}}); it checks amount but not currency and never records the provider payment id; "reprocess webhooks" only counts. There are no invoices and no workspace payment history; the admin tenant billing view returns a hard-coded `hasHistory: false`. **Status: Partially implemented.**

## 2. Decisions the business must make first

1. **Billing model.** One-time purchase with perpetual access (what the code does today) or recurring monthly/annual subscriptions (what the UI and plan semantics imply). This choice determines whether Razorpay Subscriptions (with `subscription.charged`, `subscription.halted` and related events) or one-time Orders are used.
2. **Trial policy** and what happens at trial end.
3. **Over-limit policy on downgrade:** block new creation only (recommended), or make excess resources read-only.
4. **Which limits are commercial** (seats, connectors, rows, scheduled reports, API calls, AI questions, embeds) and which are abuse guards (rate limits).

## 3. Target design

| Area | Design |
|---|---|
| Source of truth | `Subscription` holds plan, state (`trialing`, `active`, `past_due`, `restricted`, `canceled`, `expired`), current period start/end, and provider references. Access is computed from state and period on every check, not from the plan id alone |
| Plan changes | Upgrades only through a provider checkout that the webhook confirms; downgrades scheduled at period end; admin overrides through a separate, audited admin route. Workspace routes can never write `planId` directly |
| Feature entitlements | One `requireFeature(featureKey)` middleware on embed, SSO, scheduled reports, audit export, webhook connectors and AI routes |
| Quotas | Two kinds: **resource counts** (seats, connectors, dashboards, scheduled reports) computed from the database or maintained by create/delete only, and **metered usage** (API calls, queries, AI questions, stored rows) counted per period with daily or monthly keys. Atomic conditional increments; reconciliation job compares counters with real counts |
| Webhooks | Verify `X-Razorpay-Signature` (HMAC-SHA256 of the raw body); dedupe on `x-razorpay-event-id`; respond 2xx within 5 seconds and process asynchronously from a stored event; tolerate out-of-order delivery by applying state transitions only forward; poll the payment API for business-critical confirmation, as Razorpay recommends |
| Payment safety | Never mark a captured payment lost: persist the capture first, then apply the plan in an idempotent step that the reconcile job retries; alert on captured-but-unapplied payments older than a few minutes |
| Invoices and history | Workspace-visible payment history and downloadable receipts; tax fields as required by the business's jurisdiction |
| Frontend | Pricing page generated from the plan catalogue; usage meters against limits; upgrade prompts on `QUOTA_EXCEEDED`/`FEATURE_NOT_IN_PLAN` errors; accurate test/live labelling |

## 4. Tests required

- A workspace user with `iam.subscriptions.update` cannot change to a paid plan or reactivate a restricted subscription without a confirmed payment.
- A subscription past its period end without renewal loses paid features.
- Two concurrent creates at the limit: exactly one succeeds. Updates and deletes never consume quota; deletes free capacity.
- Duplicate and out-of-order webhook deliveries are idempotent (same `x-razorpay-event-id` processed once).
- A capture whose plan application fails is retried by reconcile and ends applied.
- Each plan feature is refused with a typed error on a plan that lacks it.

These are planned tests until the capabilities exist (document 17).

## 5. Findings in this area

{{BIL:free-upgrade}}, {{BIL:perm-keys}}, {{BIL:no-expiry}}, {{BIL:lost-payments}}, {{BIL:features}}, {{BIL:quota-ops}}, {{BIL:soft-limits}}, {{BIL:api-calls}}, {{BIL:default-starter}}, {{BIL:regex}}, {{BIL:reconcile-hol}}, {{BIL:authorized}}, {{BIL:catalogue-seed}}, {{BIL:no-recurring}}, {{BIL:frontend}}. Full details are in `19-findings-register.md`.

## Sources

- Razorpay, validate and test webhooks: https://razorpay.com/docs/webhooks/validate-test/
- Razorpay, webhook best practices: https://razorpay.com/docs/webhooks/best-practices/
- Razorpay, subscription webhook events: https://razorpay.com/docs/webhooks/subscriptions/
