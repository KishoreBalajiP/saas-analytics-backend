# Phase 6.1 — Razorpay Integration Plan

**Status:** Stage 0 — Audit + Implementation Plan  
**Created:** 2025-10-12  
**Scope:** Replace noop adapter with Razorpay test-mode integration without duplicating existing billing/entitlement/subscription systems.

## 1. Audit Findings (current working tree)

### 1.1 Git state
- Backend: clean, no uncommitted changes in working tree.
- Frontend: clean, no uncommitted changes.
- Phase 6 changes are already present; no new uncommitted edits.

### 1.2 Existing Phase 6 billing foundation (preserve)
- **Models**: `Subscription`, `SubscriptionHistory`, `UsageCounter`, `EntitlementOverride`. Subscription lifecycle states: `trialing | active | past_due | canceled | expired | restricted`. `subscription.service.assertTransition` is the authority; each transition creates `SubscriptionHistory` and emits `iam.subscriptions.*` audit events. Admin overrides use safety clamp (`OVERRIDE_SAFETY_FACTOR`, clamped to highest plan max*1000) with reason required.
- **Services**: `plan.service` (MasterData `plans`, `ensureDefaults()`), `subscription.service` (lifecycle authority, lazy provision on read, migration fallback), `entitlement.service` (central resolver merging plan+overrides), `usage.service` (atomic `$inc`+`upsert` on `UsageCounter` with unique `{tenantId,metric,period}`), `entitlementOverride.service`, `paymentProvider.adapter` (noop).
- **Repos/Controllers/Routes/Validators**: as documented. Workspace routes under `/api/v1/tenants/:id/*` with workspace auth + tenantIsolation. Admin billing routes present. Billing webhook at `/api/v1/billing/webhook/*` (public, 501 stub) with `ci:routes-exempt` annotations.
- **Frontend**: `BillingPanel` (Owner), Admin `BillingViews`, routes `/billing`, `/admin/plans`, `/admin/subscriptions`, `/admin/entitlements`, nav/permissions updated.
- **Webhook/raw body**: `app.js` registers `express.raw({ type: '*/*' })` for `${apiPrefix}/webhooks/*` before JSON parser. Billing webhook is at `${apiPrefix}/billing/webhook/*` — currently gets JSON-parsed (incompatible with Razorpay signature verification). Must add raw middleware for billing webhook path.

### 1.3 Config
- Central: `backend/src/config/env.js` (dotenv, frozen, validation). No Razorpay vars. `.env.example` no Razorpay.

### 1.4 CI guards
- `check-routes.js`, `check-stubs-allowlist.js` — new code must comply.

## 2. Integration approach (smallest compatible)

### 2.1 Provider model choice
- **Razorpay Subscriptions API** preferred to match recurring semantics (active/past_due/canceled/expired). Requires provider plan mapping (our `planId` → Razorpay `plan_id`). Keep authoritative plan data in MasterData; mapping server-side only (via env JSON or small config).  
- **Orders API + Checkout** also viable for one-time; less natural for renewals. Start with Subscriptions API where feasible; document merchant eligibility as outstanding if unknown. Do not fabricate support.

### 2.2 Raw body for billing webhook
Add `app.use(\`${env.app.apiPrefix}/billing/webhook\`, express.raw({ type: '*/*' }))` in `app.js` before JSON parser (same order as existing). This preserves exact bytes for HMAC verification without breaking other routes.

### 2.3 Environment variables
Backend (`src/config/env.js`, `.env.example`):
```dotenv
RAZORPAY_ENABLED=false
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
RAZORPAY_ENVIRONMENT=test  # test|live
RAZORPAY_PLAN_MAPPING_JSON=  # optional {"starter":"rp_plan_xxx",...}
```

Frontend: only public key exposed. Add `VITE_RAZORPAY_KEY_ID=` to `frontend/.env.example` and read via Vite (never expose secret/webhook secret).

Validation rules:
- If `RAZORPAY_ENABLED` true: require KEY_ID, KEY_SECRET, WEBHOOK_SECRET non-empty; require ENVIRONMENT in {test,live}.  
- Parse `RAZORPAY_PLAN_MAPPING_JSON` safely (JSON.parse with try/catch) → object|null.  
- Fail fast on startup if enabled+missing/malformed.  
- Tests run with disabled (default).  
- Explicit mode; no silent switching.

### 2.4 Adapter redesign
Replace noop with Razorpay-backed provider (feature-flagged). Expose same interface: `createCheckoutSession`, `handleWebhook`, `cancel`, `reconcile`.  
- Use official `@razorpay/razorpay` SDK.  
- Server-side verification: webhook signature via HMAC SHA256 over raw body with webhook secret (official procedure).  
- Normalize events to internal shape.  
- Include tenant/subscription refs in metadata; stable internal refs.  
- Integer minor units (paise). Validate amounts/currency from backend.  
- Timeouts, safe error handling; never log secrets/signatures/tokens.  
- Keep `_meta.implemented` accurate.

### 2.5 Webhook event allowlist
Support only events required by chosen model (Subscriptions). Define explicit allowlist; handle duplicates/out-of-order safely; retrieve authoritative state when ambiguous. Do not downgrade active subscription due to stale failure after success.

## 3. Implementation stages

### Stage 1: Env config + secrets hygiene
- Update `backend/src/config/env.js` with Razorpay section + validation.  
- Update `backend/.env.example`.  
- Update `frontend/.env.example` (VITE_RAZORPAY_KEY_ID).  
- Add config tests: disabled, valid test config, missing creds when enabled, invalid mode. Ensure no secret leakage.

### Stage 2: Razorpay provider adapter
- Add `@razorpay/razorpay` to backend dependencies if missing.  
- Rewrite `paymentProvider.adapter.js`: implement razorpay provider (uses env); keep noop fallback behavior when disabled? Or registry includes razorpay. Keep contract intact.  
- Add signature verification util.  
- Normalize responses; safe logging (no secrets).  
- Integer units, backend-resolved amounts.

### Stage 3: Checkout/subscription creation
- Add endpoint: `POST /api/v1/tenants/:tenantId/subscription/checkout` (Workspace Owner only).  
- Validate plan eligibility/current state; resolve amount/currency/interval from backend (plan).  
- Create Razorpay subscription (or order) server-side. Return minimal fields for frontend.  
- Prevent duplicate pending checkout.  
- Frontend `BillingPanel`: call backend, open Razorpay Checkout with public key; treat callbacks as untrusted (refresh authoritative status).

### Stage 4: Secure webhook processing
- Fix raw body: add raw middleware for `${apiPrefix}/billing/webhook` in `app.js`.  
- Verify `X-Razorpay-Signature` against raw body + webhook secret before processing.  
- Idempotent processing: persist webhook events (consider `WebhookEvent` model+repo) by provider event id+type.  
- Map to subscription transitions via `subscription.service` (assertTransition). Update entitlements only after valid transition.  
- Return appropriate 2xx; handle retries, duplicates, out-of-order.  
- Safe audit info; no secrets stored.

### Stage 5: Subscription lifecycle integration
- Wire verified events to `subscription.service` (add handler method if needed, don’t bypass assertTransition).  
- Store mapping `subscription.provider = { type:'razorpay', subscriptionId, orderId, ... }`.  
- Respect suspended tenant protection. Admin overrides precedence preserved.  
- Idempotent under concurrency.

### Stage 6: Reconciliation + recovery
- Implement `reconcile({ tenantId })` in adapter to pull authoritative state.  
- Provide operator-invoked mechanism (admin-only) if no scheduler; document missing scheduled production wiring. Don’t grant entitlements solely from scheduled job.

### Stage 7: Frontend billing experience
- Extend BillingPanel: eligible plan selection, initiate checkout, show pending/success/failure/cancel states, refresh after checkout.  
- Razorpay script load handling, popup blocked, errors.  
- Free tier works without gateway. Enterprise/manual distinct.  
- Never trust browser callback; wait for backend confirmation.

### Stage 8: Platform Admin + audit
- Extend admin billing views to show provider refs (redacted), webhook processing status, reconciliation outcomes. Read-only by default. Distinguish provider-confirmed vs internal. No fabricating success.

### Stage 9: Tests + security validation
- Isolated tests (mocks only). Cover env, adapter, checkout auth/cross-tenant/forgery/duplicates, webhooks (valid/invalid/missing signature, raw body, duplicates, out-of-order, unsupported), lifecycle (success/failure/grace/renew/cancel/expire/suspended/concurrent), frontend states.  
- No live calls.  
- Gates: backend tests twice, ci:guards, frontend tests/typecheck/lint/build, `git diff --check`.

### Stage 10: Documentation + release report
- Create `PHASE_6_1_RAZORPAY_INTEGRATION_PLAN.md` (this) and `PHASE_6_1_RAZORPAY_INTEGRATION_REPORT.md`.  
- Update `.env.example` files. Document test-mode setup, webhook endpoint/config, raw body, events, reconciliation, outstanding business/compliance, rollback/safe-disable. No real creds.

## 4. Business/compliance notes (documented)
- Don’t invent prices/billing intervals/refunds/tax rules; use existing plan data; flag missing decisions.  
- Verify merchant eligibility & Indian recurring-payment requirements before live.  
- Tax/invoice generation not assumed complete.  
- Live mode never auto-enabled.  
- No commit/push/deploy/production data changes.  
- Free tier remains usable without Razorpay.

## 5. Definition of Done
1. Test-mode checkout/subscription creation works (or mocks prove boundary; sandbox validation outstanding if no creds).  
2. Webhooks signature-verified, durably recorded, idempotently processed.  
3. Internal lifecycle/entitlements change only after authoritative verification.  
4. Failure/cancel/renewal/recovery tested.  
5. Frontend never grants paid access from unverified callback.  
6. Env vars validated/documented.  
7. Free tier usable without gateway.  
8. All required tests/build gates pass.  
9. Production rollout + outstanding decisions documented.  
10. Live charges disabled until explicitly authorized.
