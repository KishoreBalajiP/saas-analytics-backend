# PRODUCTION_READINESS_AUDIT.md

**Date:** 2026-10-12
**Scope:** Full repository audit (frontend + backend) for production deployment certification.
**Method:** Direct source-code inspection, configuration review, test execution, and end-to-end trace of critical paths.

---

## 1. What was inspected

### Backend (`D:\saas-analytics-platform\backend`)

| Area | Files reviewed |
|---|---|
| Application assembly & middleware | `src/app.js`, `src/middleware/*`, `src/config/cors.js` |
| Environment loading & production validation | `src/config/env.js` |
| Razorpay provider boundary | `src/services/paymentProvider.adapter.js` |
| Billing orchestration | `src/services/billing.service.js` |
| Plan pricing authority | `src/services/billingPricing.service.js` |
| Subscription lifecycle | `src/services/billingLifecycle.service.js` |
| Reconciliation sweep | `src/services/billingReconcile.service.js`, `src/jobs/billingReconcile.job.js` |
| Models | `src/models/Subscription.js`, `src/models/PaymentTransaction.js`, `src/models/Tenant.js` |
| Routes | `src/routes/billing-webhook.routes.js`, `src/routes/subscription.routes.js`, `src/routes/admin-subscription.routes.js` |
| Plan catalogue | `src/services/plan.service.js` |
| Cache/queue infrastructure | `src/cache/redis.js`, `src/cache/memory.js`, `src/services/cache.service.js`, `src/queues/index.js` |
| Security middleware | `helmet`, CORS, rate-limiter, `src/middleware/tenantIsolation.middleware.js` |
| Tests | `tests/billing-integration.test.js`, `tests/razorpay-billing.test.js`, `tests/config/production-config.test.js`, full suite |

### Frontend (`D:\saas-analytics-platform\frontend`)

| Area | Files reviewed |
|---|---|
| Billing UI | `src/features/billing/components/BillingPanel.tsx` |
| Billing API client | `src/features/billing/api.ts`, `src/features/billing/api.test.ts` |
| Environment configuration | `.env`, `.env.example`, `.env.test` |
| Build config | `vite.config.ts`, `package.json` |
| Test infrastructure | `vitest.config.ts`, test files |

### Configuration

| File | Reviewed |
|---|---|
| `backend/.env` | All variables (secrets redacted in this report) |
| `backend/.env.example` | All variables |
| `frontend/.env`, `frontend/.env.example`, `frontend/.env.test` | All variables |

---

## 2. Issues found and fixed in this audit

| # | Severity | Issue | Root cause | Fix |
|---|---|---|---|---|
| 1 | **High** | Razorpay production gate absent. When `RAZORPAY_ENABLED=true`, the production config validator did **not** check for `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_ENVIRONMENT`, or `RAZORPAY_PLAN_MAPPING_JSON`. A misconfigured production could go live with empty credentials, an invalid environment, or no plan pricing — checkout would fail in obscure ways. | `src/config/env.js` lines 353–376 had no Razorpay branch. | Added a Razorpay branch in the production validator. When `RAZORPAY_ENABLED=true`, all four credentials and a non-empty plan mapping are required, and `RAZORPAY_ENVIRONMENT` must be `test` or `live`. Covered by 4 new tests in `tests/config/production-config.test.js`. |
| 2 | **Medium** | No focused tests for the `RAZORPAY_PLAN_MAPPING_JSON` schema (amountMinor, currency, interval validation). The schema is the single source of truth for pricing; regressions here would silently break production checkout. | Pricing tests were spread across integration tests; no focused unit tests for the schema. | Added `tests/billing-pricing.test.js` with 20 focused tests covering: valid mappings, unknown plan codes, missing fields, non-integer/zero/negative amounts, amounts above the sanity ceiling, unsupported currencies, lowercase normalization, non-`one-time` intervals, non-object entries, `isPurchasable` semantics, `listPricedPlans` filtering, and `formatMinor`. |
| 3 | **Low** | `RAZORPAY_PLAN_MAPPING_JSON` schema was documented only in JSDoc and a commented-out example in `.env.example`. No canonical operator-facing guide. | Documentation gap. | Added `RAZORPAY_CONFIGURATION_GUIDE.md` with the exact schema, currency rules, validation behaviour, and a placeholder example explicitly labelled as not production-ready. |
| 4 | **Low** | Webhook URL, event configuration, and secret-selection instructions were not documented for the operator. | Documentation gap. | Documented in `RAZORPAY_CONFIGURATION_GUIDE.md` and `PRODUCTION_DEPLOYMENT_RUNBOOK.md`, using the route derived from the mounted Express routers: `${BACKEND_URL}/api/v1/billing/webhook`. |

### Issues confirmed and verified not to need code change

| Area | Finding | Evidence |
|---|---|---|
| Checkout signature verification | HMAC-SHA256 with constant-time comparison. Uses `RAZORPAY_KEY_SECRET`, not the webhook secret. | `paymentProvider.adapter.js:verifyCheckoutSignature` |
| Webhook signature verification | HMAC-SHA256 against the raw body, constant-time. Uses `RAZORPAY_WEBHOOK_SECRET`. Raw body preserved by `express.raw` configured in `app.js` for the webhook path. | `paymentProvider.adapter.js:verifyWebhookSignature`, `app.js` raw-body middleware for `/api/v1/billing/webhook` |
| Idempotency | Conditional updates via `paymentTransactionRepository.transitionStatus(from:['pending'], to:'captured')`; `WebhookEvent` deduplication by `eventId`; `findPendingForTenantPlan` reuse; single-flight in reconcile. | `billing.service.js`, `billing-webhook.routes.js`, `billingReconcile.service.js` |
| Server-authoritative pricing | All amounts from `RAZORPAY_PLAN_MAPPING_JSON`; client cannot supply amount/currency. Live payment fetched from Razorpay after signature verify; amount/currency/order_id/status/captured all asserted against the stored transaction. | `billing.service.js:createCheckout`, `verifyCheckout` |
| Webhook → subscription gating | Suspended/disabled/archived tenants and `restricted` subscriptions are blocked from activation even on verified payment. | `billingLifecycle.service.js:guards` |
| CORS / credentials | `cors(corsConfig)` with the existing allow-list; no `*` or localhost entries in production. | `config/cors.js` + production validator |
| Helmet / security headers | Default Helmet headers + custom CSP + production-only HSTS + X-Powered-By disabled. 14 focused tests added in Phase 9.11. | `app.js`, `tests/security-headers.test.js` |
| Redis readiness | `REDIS_URL` required in production; in-memory fallback for dev/test only. 8 focused tests added in Phase 9.11. | `config/env.js`, `cache.service.js`, `tests/cache/redis-production-readiness.test.js` |
| Frontend secret handling | `keyId` flows from the backend via the secure checkout response (`session.keyId`), not from a frontend env var. No `RAZORPAY_KEY_SECRET` or `RAZORPAY_WEBHOOK_SECRET` in any frontend file. | `BillingPanel.tsx:370`, `api.ts` |

---

## 3. Environment variable inventory (high-level)

| Variable | Category | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | Required (prod=production) | `development` | Gates production validator. |
| `PORT` | Optional | `8080` | Listening port. |
| `MONGODB_URI` | **Required (prod)** | localhost | No safe production default. |
| `REDIS_URL` | **Required (prod)** | (empty → in-memory) | Production refuses to start without it. |
| `JWT_SECRET` | **Required (prod)** | dev-only default → rejected | Long random string in prod. |
| `ENCRYPTION_KEY` | **Required (prod)** | (empty) | ≥32 chars in prod. |
| `COOKIE_SECURE` | **Required (prod)** | `true` in prod | HTTPS-only cookies. |
| `STORAGE_PROVIDER` | **Required (prod)** | `local` (rejected in prod) | `s3` in prod. |
| `S3_*` | **Required (prod when STORAGE_PROVIDER=s3)** | — | Bucket, region, keys, endpoint. |
| `MAIL_PROVIDER`, `SMTP_HOST`, `MAIL_PASSWORD` | **Required (prod)** | — | Transactional email. |
| `CLIENT_URL` | **Required (prod)** | localhost (rejected) | Deployed frontend URL. |
| `CORS_ORIGINS` | **Required (prod)** | localhost (rejected) | Comma-separated allow-list. |
| `SOCKET_CORS_ORIGIN` | **Required (prod)** | localhost (rejected) | WebSocket origin. |
| `TRUST_PROXY` | Optional | `1` | Reverse-proxy hops. |
| `RATE_LIMIT_*` | Optional | tuned defaults | Rate-limiting window/cap. |
| `RAZORPAY_ENABLED` | **Required (prod, when true)** | `false` | Gates all Razorpay vars. |
| `RAZORPAY_KEY_ID` | **Required (prod, when enabled)** | (empty) | Public key. |
| `RAZORPAY_KEY_SECRET` | **Required (prod, when enabled)** | (empty) | Server-only. |
| `RAZORPAY_WEBHOOK_SECRET` | **Required (prod, when enabled)** | (empty) | Server-only. |
| `RAZORPAY_ENVIRONMENT` | **Required (prod, when enabled)** | `test` | Must be `test` or `live`. |
| `RAZORPAY_PLAN_MAPPING_JSON` | **Required (prod, when enabled)** | (empty → none purchasable) | Server-authoritative pricing. |
| `JOB_BILLING_RECONCILE_ENABLED` | Optional | `false` | Recommended `false` until verified. |
| `JOB_BILLING_RECONCILE_CRON` | Optional | `*/15 * * * *` | Cron expression. |
| `JOB_*_ENABLED` | Optional | `false` | Other background jobs. |
| `LOG_LEVEL`, `LOG_REDACT` | Optional | `info` / default redact | Production observability. |
| `SHUTDOWN_TIMEOUT_MS` | Optional | `10000` | Graceful shutdown. |
| `VITE_API_BASE_URL` | Frontend (Vercel) | — | Backend public URL. |
| `VITE_API_PREFIX` | Frontend (Vercel) | `/api/v1` | Must match backend. |
| `VITE_RAZORPAY_KEY_ID` | Frontend (Vercel, optional) | (empty) | **Not used** — `keyId` flows from backend via checkout response. Retained for forward compatibility only. |

Full deployment matrix is in `PRODUCTION_DEPLOYMENT_RUNBOOK.md`.

---

## 4. Test results (actual)

### Backend

| Suite | Result |
|---|---|
| Full backend suite (`node scripts/ci/run-tests.js`) | **552/552 pass, 0 fail, 0 cancelled, 0 skipped** |
| Billing pricing schema (new, this audit) | 20/20 pass |
| Production config gate (new, this audit) | 6/6 pass (includes 4 new Razorpay-gate tests) |
| Razorpay billing integration (`tests/razorpay-billing.test.js`) | 27/27 pass (test-mode sandbox only) |
| Tenant isolation | Pass (existing suite) |
| Entitlement / quota | Pass (existing suite) |
| Webhook idempotency / out-of-order | Pass (existing suite) |
| Reconciliation single-flight | Pass (existing suite) |

### Frontend

| Suite | Result |
|---|---|
| Vitest (`npm test`) | **244/244 pass across 27 test files** |

### CI guards

| Guard | Result |
|---|---|
| `check-stubs` | OK |
| `check-routes` | OK |
| `check-models` | OK |
| `check-config` | OK |
| `check-readme-sync` | OK |

---

## 5. Deferred work (explicitly out of scope for this task)

| Item | Reason | Documented in |
|---|---|---|
| MongoDB automated backups | Out of scope per task rules | `PRODUCTION_DEPLOYMENT_RUNBOOK.md` §"Deferred operational work" |
| Email delivery monitoring | Out of scope per task rules | `PRODUCTION_DEPLOYMENT_RUNBOOK.md` §"Deferred operational work" |
| Real Razorpay provider end-to-end (test-mode real keys) | Not authorised; no live charges | `RAZORPAY_CONFIGURATION_GUIDE.md` §"Live end-to-end verification" |
| Impersonation token rotation | Phase 9.8 P2; not raised in this audit | `PRODUCTION_DEPLOYMENT_RUNBOOK.md` §"Known deferred items" |
| Refresh token rotation on login | Phase 9.8 P2; not raised in this audit | `PRODUCTION_DEPLOYMENT_RUNBOOK.md` §"Known deferred items" |
| Automatic recurring Razorpay subscriptions | Explicitly out of scope per task rules ("Analivo currently uses one-time Razorpay orders") | `RAZORPAY_CONFIGURATION_GUIDE.md` §"Billing model" |

---

## 6. Manual configuration required (cannot be done from this audit)

| # | Action | Owner | Where | Verification |
|---|---|---|---|---|
| 1 | Confirm actual commercial prices for `starter` and `pro` (paise, INR) and write them into `RAZORPAY_PLAN_MAPPING_JSON`. | Business owner | Backend hosting provider env vars | Backend startup does not throw on `Invalid production configuration`; `GET /api/v1/tenants/:id/plans` returns `purchasable: true` for priced plans. |
| 2 | Obtain Razorpay **test** API Key ID, Key Secret, and Webhook Secret. Set them in backend env. | Developer / operator | Razorpay Dashboard (Test Mode) → Settings → API Keys; Settings → Webhooks | `RAZORPAY_ENABLED=true`, `RAZORPAY_ENVIRONMENT=test`; backend starts; checkout returns non-501. |
| 3 | Configure Razorpay webhook for the deployed backend. | Developer / operator | Razorpay Dashboard (Test Mode) → Settings → Webhooks → New Webhook | URL: `${BACKEND_URL}/api/v1/billing/webhook`; Secret = the value of `RAZORPAY_WEBHOOK_SECRET`; Active events: `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed`. |
| 4 | Verify webhook delivery end-to-end (test mode). | Developer | Razorpay Dashboard → Webhooks → Logs | A test event arrives, backend responds 200, `WebhookEvent` row appears, audit log shows `billing.webhook_processed`. |
| 5 | (Only after all test-mode gates pass) Switch to live mode. | Operator (authorised) | Backend env: `RAZORPAY_ENABLED=true`, `RAZORPAY_ENVIRONMENT=live`, live key/secret/webhook secret from Razorpay Live Dashboard | `Razorpay Live Dashboard → Webhooks` configured for production URL with live webhook secret; one end-to-end test of ₹1 against a live plan, then admin rollback or refund. |
| 6 | (Only after live test) Enable the billing reconciliation job. | Operator | Backend env: `JOB_BILLING_RECONCILE_ENABLED=true` | Scheduler log shows `billing-reconcile` firing on cron. |

---

## 7. Verdict

**Code, tests, and configuration gates: ✅ all pass.** All 552 backend tests and 244 frontend tests pass. All 5 CI guards pass. No critical/high code issues remain.

**External configuration: ❌ not verifiable from this audit.** Real commercial prices, real Razorpay credentials, real webhook delivery, and real live-mode activation all require operator/business action against the Razorpay Dashboard and business pricing decisions.

**Status: READY FOR STAGING CONFIGURATION** (see final report).
# Current certification update — 2026-10-23

The current final status is **BLOCKED**. See `ANALIVO_PRODUCTION_READINESS_FINAL_REPORT.md` and `ANALIVO_ENVIRONMENT_VARIABLE_AUDIT.md`. Remaining gates are frontend lint/test failures, full backend Node 24/26 verification, legal approval of customer-facing policies, and authorized production secret/provider validation.
