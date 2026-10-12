# RAZORPAY_CONFIGURATION_GUIDE.md

**Audience:** Backend operator / DevOps engineer / Business owner.
**Purpose:** The single, copy-paste-ready guide to configure the Analivo Razorpay integration for test mode, staging, and live mode — without ever printing or inventing secret values.

---

## 1. Billing model

Analivo uses **one-time Razorpay orders** (Phase 6.1). There is **no automatic recurring billing**. A customer pays once for a plan; renewal requires another one-time order.

This is enforced in code by `src/services/billingPricing.service.js`:

```js
export const SUPPORTED_INTERVAL = 'one-time';
```

Any `RAZORPAY_PLAN_MAPPING_JSON` entry with `interval: "monthly"` (or any value other than `"one-time"`) is rejected at startup / first checkout attempt. Migrating to recurring billing is a separate, out-of-scope follow-up.

---

## 2. The `RAZORPAY_PLAN_MAPPING_JSON` schema

The plan catalogue (in `src/services/plan.service.js`) defines plans `free`, `starter`, `pro`, `enterprise`. The plan catalogue carries **no commercial pricing** (no `amountMinor`, no `currency`, no `interval`). Commercial pricing is configured **only** via `RAZORPAY_PLAN_MAPPING_JSON`.

### Schema (per plan code)

```json
{
  "<planCode>": {
    "amountMinor": <positive integer>,
    "currency":    "INR",
    "interval":    "one-time"
  }
}
```

### Field rules

| Field | Type | Rules |
|---|---|---|
| `<planCode>` | string | Must match an existing plan (`free`, `starter`, `pro`, `enterprise`). The `free` plan is never purchasable. |
| `amountMinor` | integer | Positive integer in the **smallest currency unit** (paise for INR). No floats. No negative or zero. Hard ceiling: `100_000_000_00` (10 crore paise) as a sanity guard. |
| `currency` | string | 3-letter ISO code, normalised to uppercase. **Only `INR` is currently supported**; any other value is rejected (not coerced). |
| `interval` | string | Must be exactly `"one-time"`. Anything else is rejected. |

### What gets rejected at the validation boundary

- Malformed JSON: silently yields an empty mapping at startup (no crash). To fail fast, the production validator now rejects `RAZORPAY_ENABLED=true` with an empty mapping.
- Missing `amountMinor`, `currency`, or `interval` on a plan entry.
- Non-integer `amountMinor` (e.g. `999.5`).
- `amountMinor` ≤ 0.
- `amountMinor` above the sanity ceiling.
- Unsupported currency (anything other than `INR`).
- `interval` ≠ `"one-time"`.
- A plan code that is not in the plan catalogue.

All rejections are `ApiError.validation` (HTTP 422) with a clear message. They never silently coerce to zero or default.

### Frontend–backend price agreement

The frontend pricing UI uses the backend's `GET /api/v1/tenants/:id/plans` response, which is sourced from `listPricedPlans()` in `billingPricing.service.js`. The **same** mapping is used by:

- `GET /api/v1/tenants/:id/plans` — public catalogue view (filtered to valid entries).
- `POST /api/v1/tenants/:id/subscription/checkout` — authoritative price for the Razorpay order.
- `POST /api/v1/tenants/:id/subscription/verify` — authoritative amount/currency for signature verification and provider re-fetch.

The frontend **never** displays a price that disagrees with the backend, because the frontend fetches the price from the backend. Hardcoded prices in the frontend are prohibited by this design.

---

## 3. Example `RAZORPAY_PLAN_MAPPING_JSON` (placeholder prices)

The values below are **clearly labelled placeholders**. The actual commercial prices must be supplied by the business owner before live activation. Do **not** ship to production with these values.

```json
{
  "starter": {
    "amountMinor": 49900,
    "currency":    "INR",
    "interval":    "one-time"
  },
  "pro": {
    "amountMinor": 99900,
    "currency":    "INR",
    "interval":    "one-time"
  }
}
```

In INR: `49900` paise = ₹499.00, `99900` paise = ₹999.00.

**To use in `.env`:**

```bash
# IMPORTANT: this is a single-line JSON; the value must not contain literal newlines.
# The example below uses the placeholder prices from the .env.example comment block.
RAZORPAY_PLAN_MAPPING_JSON={"starter":{"amountMinor":49900,"currency":"INR","interval":"one-time"},"pro":{"amountMinor":99900,"currency":"INR","interval":"one-time"}}
```

**Commercial prices are NOT decided in this build.** The business owner must supply the real `amountMinor` for each plan before live activation. Until then, production checkout is blocked at the configuration gate if `RAZORPAY_ENABLED=true` and the mapping is empty.

---

## 4. Other Razorpay environment variables

| Variable | Required (prod, when enabled) | Purpose | Default |
|---|---|---|---|
| `RAZORPAY_ENABLED` | ✅ | Master switch. When `false`, every checkout returns HTTP 501 honestly. | `false` |
| `RAZORPAY_KEY_ID` | ✅ | Public key ID. Sent to the browser via the checkout response (`session.keyId`). Safe to expose. | (empty) |
| `RAZORPAY_KEY_SECRET` | ✅ | **Server-only.** Used to verify checkout HMAC signatures. Never sent to the browser. Never logged. | (empty) |
| `RAZORPAY_WEBHOOK_SECRET` | ✅ | **Server-only.** Used to verify Razorpay webhook HMAC signatures against the raw request body. Never sent to the browser. Never logged. | (empty) |
| `RAZORPAY_ENVIRONMENT` | ✅ | `test` or `live`. Anything else is rejected. The application never auto-switches. | `test` |
| `JOB_BILLING_RECONCILE_ENABLED` | Optional | Enable the cron-based reconciliation sweep. Recommended `false` until deployment topology is verified. | `false` |
| `JOB_BILLING_RECONCILE_CRON` | Optional | Cron expression for reconciliation. | `*/15 * * * *` |
| `VITE_RAZORPAY_KEY_ID` | Not used by the application | The frontend receives the `keyId` from the backend's checkout response. This env var is retained only for forward compatibility and can stay empty. | (empty) |

---

## 5. Razorpay Dashboard configuration (test mode)

### 5.1 Where to create the API keys

1. Razorpay Dashboard → **Settings** → **API Keys** (under "Account & Profile").
2. Generate a **Test Mode** key pair. Note: the dashboard will display the secret **once**; copy it immediately.
3. Set in the backend hosting provider:
   - `RAZORPAY_KEY_ID` = the displayed Key ID (e.g. `rzp_test_…`).
   - `RAZORPAY_KEY_SECRET` = the displayed secret.
4. Set `RAZORPAY_ENABLED=true` and `RAZORPAY_ENVIRONMENT=test` in the backend.

### 5.2 Where to create the webhook

1. Razorpay Dashboard → **Settings** → **Webhooks** → **Create New Webhook**.
2. **Webhook URL:** `${BACKEND_URL}/api/v1/billing/webhook`
   - For the current deployment this is `https://saas-analytics-backend-ffao.onrender.com/api/v1/billing/webhook`.
3. **Secret:** a long random string. Set the same string as `RAZORPAY_WEBHOOK_SECRET` in the backend. This is **not** the API Key Secret; it is a separate secret used only for HMAC verification of webhook bodies.
4. **Active events:** select at least these (the implementation supports only these):
   - `payment.captured`
   - `payment.failed`
   - `order.paid`
   - `refund.created`
   - `refund.processed`
5. **Method:** `POST` (the implementation accepts only `POST`).

### 5.3 How to verify webhook delivery

1. After configuring, trigger a test payment in test mode.
2. Razorpay Dashboard → **Webhooks** → click the webhook → **Logs** tab. You should see entries with HTTP 200 from the backend.
3. If the backend is on Render (or any hosted platform), also check the platform's request logs to see the inbound `POST /api/v1/billing/webhook`.
4. In the database, the `WebhookEvent` collection should have new rows with `provider: 'razorpay'`, `eventType` matching what Razorpay sent, and `processedAt` populated.
5. Audit log entries (`billing.webhook_processed`, `billing.webhook_refused`, `billing.webhook_unknown_order`) confirm the backend's decision.

### 5.4 Distinguishing webhook configuration errors from backend processing errors

| Symptom | Likely cause | Where to look |
|---|---|---|
| Razorpay Logs shows non-2xx, body is `{"message":"Invalid webhook signature"}` | `RAZORPAY_WEBHOOK_SECRET` does not match the webhook's configured secret, or the backend is reading the parsed JSON body instead of raw bytes. | Backend env var; verify `app.js` registers `express.raw` for `/api/v1/billing/webhook`. |
| Razorpay Logs shows non-2xx, body is `{"message":"Provider unavailable"}` | `RAZORPAY_ENABLED=false` or `RAZORPAY_KEY_SECRET` is empty. | Backend env; startup validator (when in production). |
| Razorpay Logs shows 200 but `WebhookEvent` row not present in DB | Backend DB write failed; usually a transient MongoDB issue. | Backend logs (`err.message` and `requestId`); platform monitoring. |
| Razorpay Logs shows 200 with `{"received":true,"processed":false,"reason":"duplicate_delivery"}` | Expected behaviour for retries; first event was already processed. | No action. |
| Razorpay Logs shows 200 with `{"received":true,"processed":false,"reason":"unsupported_event"}` | Event type not in the implementation's allowlist. | Either enable the event on the Razorpay Dashboard, or accept that it is intentionally unsupported. |
| Razorpay Logs shows 200 with `{"received":true,"processed":true,"outcome":"refused_*"}` | Webhook was valid but the business rule rejected activation (suspended tenant, restricted subscription). | Audit log: `billing.webhook_refused`. No code change needed. |

---

## 6. Test-mode end-to-end (safe, no live charges)

This is the minimum verification before authorising live mode. Do **not** skip any step.

1. Confirm `RAZORPAY_ENABLED=true`, `RAZORPAY_ENVIRONMENT=test` in the deployed backend.
2. Confirm `RAZORPAY_PLAN_MAPPING_JSON` has at least one priced plan.
3. Confirm the Razorpay Dashboard webhook is configured per §5.2 and is **Active**.
4. As a workspace Owner, open the billing page, click **Upgrade** on a priced plan.
5. The Razorpay Checkout modal opens with the `keyId` (test key prefix `rzp_test_…`).
6. Use Razorpay's test card `4111 1111 1111 1111`, any future expiry, any CVV.
7. On success, the modal closes, the backend verifies the signature, the subscription activates, and the UI reflects the new plan.
8. Verify in the database: a `PaymentTransaction` with `status: 'captured'`, a `Subscription` with `state: 'active'` and `paymentProvider: 'razorpay'`, a `WebhookEvent` row (if Razorpay also delivered the webhook), and audit log entries.
9. Test failure: use Razorpay's test card `4000 0000 0000 0002` (payment failure). The subscription must not activate. A `PaymentTransaction` with `status: 'failed'` and `failureReason` is recorded.
10. Test idempotency: trigger the same test card payment twice (e.g. by re-clicking the checkout button). The second attempt must reuse the same pending order (no duplicate Razorpay orders), and only one transaction row reaches `captured`.

---

## 7. Live end-to-end (NOT YET VERIFIED in this audit)

**This audit did not perform a live-mode end-to-end test.** Authorising live mode is a separate, operator-controlled decision.

When authorised:

1. Switch the backend env to `RAZORPAY_ENABLED=true`, `RAZORPAY_ENVIRONMENT=live`.
2. Replace the test credentials with the live credentials from the Razorpay Live Dashboard.
3. Create a **new** webhook on the Live Dashboard for `${BACKEND_URL}/api/v1/billing/webhook` with a fresh, separate `RAZORPAY_WEBHOOK_SECRET`.
4. Restart / redeploy the backend.
5. Perform one end-to-end test against a **low-value** live plan (e.g. ₹1 if your mapping allows it; otherwise the smallest priced plan).
6. Verify the subscription activates and the audit trail matches.
7. If successful, the business owner can authorise opening live checkout to all tenants.

**Live mode is not silently activated.** A change from `RAZORPAY_ENVIRONMENT=test` to `RAZORPAY_ENVIRONMENT=live` requires:

- Live API Key ID and Key Secret in env.
- A separate live Webhook Secret in env.
- A separate webhook configured on the Razorpay Live Dashboard.
- A redeploy.

Mixing test and live credentials in the same deployment is impossible because:

- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are bound to one environment (the prefix `rzp_test_` or `rzp_live_` is part of the Key ID).
- `RAZORPAY_WEBHOOK_SECRET` is bound to a specific webhook on a specific dashboard.
- The production validator requires `RAZORPAY_ENVIRONMENT` to be explicitly `test` or `live`.

---

## 8. Reconciliation job (recommended posture)

| Stage | `JOB_BILLING_RECONCILE_ENABLED` | Rationale |
|---|---|---|
| Local development | `false` | Reconciliation is meaningless without a real provider. |
| Test mode (staging) | `false` initially; enable after the test webhook is configured and one full test-cycle completes. | The job is idempotent and single-flight per process, but the deployment topology must be verified first. |
| Production (single-instance) | `true` after the first live test payment succeeds. | Catches webhooks that Razorpay failed to deliver. |
| Production (multi-instance) | **Caution** — see below. | Without distributed coordination, multiple instances may all run the cron at the same time. The service is single-flight **per process**, so each instance's run is safe, but the same payment may be processed by multiple instances and the `paymentTransactionRepository.transitionStatus` conditional update will let only one win. Operationally wasteful but safe. To avoid, deploy with a single backend instance OR add a distributed lock (not implemented in this build). |

Recommendation: **keep `JOB_BILLING_RECONCILE_ENABLED=false` until the deployment topology and the test-mode end-to-end are verified.** The manual `POST /api/v1/admin/subscriptions/reconcile` admin endpoint is always available for ad-hoc recovery, regardless of the cron setting.

---

## 9. Frontend integration

The frontend does **not** need a Razorpay env var. The `keyId` is delivered from the backend via the secure checkout response:

```
POST /api/v1/tenants/:id/subscription/checkout
→ { transactionId, orderId, keyId, amountMinor, currency, planId, reused }
```

The frontend then opens `window.Razorpay({ key: session.keyId, amount: session.amountMinor, currency: session.currency, order_id: session.orderId, ... })` (see `frontend/src/features/billing/components/BillingPanel.tsx`).

`VITE_RAZORPAY_KEY_ID` in the frontend env files is **not consumed** by the application code. It is retained for forward compatibility only. It can be left empty.

---

## 10. Troubleshooting checklist

| Symptom | First check |
|---|---|
| `POST /api/v1/tenants/:id/subscription/checkout` returns 501 | `RAZORPAY_ENABLED` is `false`, or `RAZORPAY_KEY_SECRET` is empty. |
| `POST /api/v1/tenants/:id/subscription/checkout` returns 422 with "no configured pricing" | The requested plan is not in `RAZORPAY_PLAN_MAPPING_JSON`, or its entry is malformed. |
| `POST /api/v1/tenants/:id/subscription/verify` returns 400 with "signature mismatch" | The frontend received a different signature than expected; usually a clock-skew or proxy modification issue. The signature is computed by Razorpay's Checkout over `{order_id}|{payment_id}` with `RAZORPAY_KEY_SECRET`. |
| `POST /api/v1/tenants/:id/subscription/verify` returns 400 with "amount/currency mismatch" | The amount/currency from Razorpay's API does not match what the backend stored. Almost always means a stale cached mapping or a manually-crafted order. |
| Webhook not received | URL misconfigured, secret mismatch, or the path is wrong. Verify with `curl` that the endpoint returns 200 to a `GET` (the implementation has a public `/health` endpoint at `GET /api/v1/billing/webhook/health`). |
| Cron job not firing | `JOB_BILLING_RECONCILE_ENABLED=false`, or `RAZORPAY_ENABLED=false`, or the scheduler itself is not running. Check `SCHEDULER_ENABLED=true` and the platform logs for `billing-reconcile` entries. |

---

## 11. Files that consume Razorpay configuration

| File | Reads | Purpose |
|---|---|---|
| `src/config/env.js` | All `RAZORPAY_*` env vars | Loads and validates configuration. Production gate added in this audit. |
| `src/services/paymentProvider.adapter.js` | `config.razorpay.*` | Builds the Razorpay provider. Performs HMAC verification. |
| `src/services/billingPricing.service.js` | `config.razorpay.planMapping` | Resolves the authoritative price for a plan. Validates the mapping schema. |
| `src/services/billing.service.js` | `config.razorpay.*` (via provider) | Creates orders, verifies signatures, fetches live payments, applies capture. |
| `src/services/billingReconcile.service.js` | `config.razorpay.*` (via provider) | Sweeps pending transactions. |
| `src/routes/billing-webhook.routes.js` | `RAZORPAY_WEBHOOK_SECRET` (via provider) | Verifies webhook signatures against raw body. |
| `tests/config/production-config.test.js` | (test fixtures) | Asserts the production validator rejects incomplete Razorpay config. |
| `tests/billing-pricing.test.js` | (test fixtures) | Asserts the schema validator. |
