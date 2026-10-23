# Billing, Subscription, and Entitlement Audit

Date: 2026-10-24

## Outcome

The workspace billing page now separates the server-resolved current subscription from an unpaid or still-applying checkout. A pending Starter transaction does not change the displayed current plan: the page continues to show Free as current and labels Starter as pending until the backend confirms and applies the payment.

## Root causes and findings

### Current and pending state

The subscription endpoint and entitlement resolver already used the canonical subscription row and computed access state. Payment activation is performed by the billing lifecycle only after provider verification/capture. The former UI presented only the current subscription and payment history, so an outstanding checkout was easy to misunderstand. The UI now reads recent transaction state and renders a separate pending-purchase panel; it does not grant access or infer activation from the browser callback.

### Plan and feature source of truth

Plan names, prices, currency, intervals, feature keys, limits, and purchasability continue to come from `GET /tenants/:id/plans`. Effective access continues to come from `GET /tenants/:id/entitlements`, which resolves the subscription, plan, aliases, overrides, state, and write blocking on the backend. The billing UI now compares every feature key present in the backend catalogue and uses presentation-only human labels. It distinguishes `Available`, `Included, not ready`, and `Not included`; it does not turn a label into an entitlement.

The feature keys shown disabled for a Free workspace are disabled because the current plan does not include them. A feature that is included in the plan but requires workspace/platform configuration remains distinguishable from a feature that is not entitled. Backend `requireFeature` checks remain the authorization boundary.

### Settings consistency

The earlier discrepancy was caused by Settings consuming feature-flag evaluations while Billing consumed only the effective entitlement map. The Settings surface now receives detailed backend evaluation data, including plan inclusion and configuration/operational reasons, while Billing uses the canonical entitlement response for effective access and the plan catalogue for comparison. Neither surface independently enables a feature from a plan name.

### History and duplicate-looking events

Subscription history is append-only and is generated for real state transitions. `ensureForTenant` returns an existing subscription without appending another `subscription.created` row, so normal repeated reads do not create duplicate creation events. Existing duplicate-looking records were not deleted or deduplicated. Timeline ordering is now stable for equal timestamps, and the workspace timeline route validates page/limit parameters so long histories can be paged.

### Payment lifecycle and authorization

The existing flow remains server-authoritative:

1. The client requests a server-priced checkout session using only plan code and interval.
2. The backend validates the active catalogue plan and configured term price, creates the provider order, and binds the transaction to the tenant.
3. The provider callback is sent back for signature verification; verified webhooks/capture processing are idempotent and apply the paid term through the billing lifecycle.
4. Entitlements are recalculated from the canonical subscription and the client refreshes billing queries.

The frontend now prevents parallel purchase actions while a checkout/pending payment is active. It still never treats checkout success or dismissal as proof of entitlement. Tenant isolation and backend feature middleware were not bypassed.

## Files changed for this billing task

- `frontend/src/features/billing/components/BillingPanel.tsx` — current/pending separation, catalog-backed summary, human-readable activity, full feature comparison.
- `frontend/src/features/billing/components/PricingPlans.tsx` — catalog feature labels and pending purchase protection.
- `frontend/src/features/billing/components/BillingHistory.tsx` — readable payment history pagination.
- `frontend/src/features/billing/featureCatalog.ts` — presentation metadata only; no entitlement decisions.
- `frontend/src/features/billing/api.ts` — paged subscription timeline response.
- `backend/src/routes/subscription.routes.js` — validated timeline pagination query.
- `backend/src/repositories/subscription.repository.js` — stable timeline ordering.

## Verification

Executed successfully:

- Frontend billing tests: 3 files, 15 tests passed.
- Frontend `npm run typecheck` passed.
- Frontend `npm run lint -- --quiet` passed with 0 errors; the full lint output retains 9 existing Fast Refresh warnings.
- Frontend build was run in the preceding validation pass and passed.
- Backend changed-file syntax checks and `npm run ci:guards` passed in the preceding validation pass.
- Existing settings/support/features/MFA frontend suite: 5 files, 22 tests passed.
- Existing auth/legal frontend suite: 4 files, 34 tests passed.

The Mongo-backed backend integration suites remain environment-blocked before test hooks by the installed `mongodb-memory-server` binary MD5 mismatch (binary `6e07910245143d0b2af06ac656dac326`, checkfile `b794b99d839b73b3862972d2e170018f`). No production payment or subscription records were touched, and no real checkout was initiated.

## Remaining risks and configuration

- Razorpay checkout remains unavailable when the backend provider is not configured or enabled; the UI reports that state from the backend catalogue response.
- Included-but-not-operational capabilities still require their documented provider, tenant configuration, consent, or platform policy setup.
- Browser viewport automation was unavailable in this environment, so responsive behavior was verified through responsive classes and component tests rather than a live browser session.

## Subscription-page follow-up

The follow-up audit confirmed that the disabled-looking Starter/Pro buttons were caused by the frontend condition `Boolean(pendingPlanId)`, which disabled every paid plan whenever any pending transaction existed. The backend was already designed to reuse an equivalent open checkout (`findPendingForTenantPlan`) and return `reused: true`; no backend entitlement or payment change was needed.

The page now enables `Choose <plan>` when the catalog says checkout is permitted, disables only other parallel choices while a pending order exists, and exposes `Continue payment` for the matching open order. Captured-but-unapplied transactions show `Check payment status` and never reopen payment. When provider configuration makes checkout unavailable, the page explains that state without displaying a misleading disabled purchase button. Plan cards use equal-height flex layout with actions aligned at the bottom.

Follow-up frontend billing verification: 2 test files, 11 tests passed; frontend typecheck passed; production build passed; lint passed with the same 9 existing Fast Refresh warnings and no errors. No browser payment or production checkout was performed.
