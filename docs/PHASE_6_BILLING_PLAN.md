# Phase 6 — Plans, Billing, Subscriptions and Entitlements

> Status: **Stage 0 — Plan** (audit + design). Implementation follows in Stages 1–10
> after this plan is read.
>
> Phase 5 gaps (MFA audit-event emission, support impersonation start/stop UI)
> remain **open** and are not addressed by Phase 6. They are surfaced again in
> the report and are not silently marked complete.

---

## 0. Scope and goals

Phase 6 introduces a production-grade SaaS plan and entitlement foundation:

- A configurable plan catalogue.
- Tenant subscriptions and an explicit lifecycle state machine.
- Centralised entitlements and quotas.
- Usage metering for resources that the application actually ships today.
- Backend-enforced quotas at the write boundary, safe under concurrency.
- Workspace Owner self-service subscription management.
- Platform Admin plan and subscription administration.
- Audited administrative overrides.
- A safe, provider-neutral integration boundary for future payment processing.

Phase 6 does **not** pick a payment provider, does **not** invent commercial
pricing, and does **not** change any tenant-facing behaviour outside the new
billing surface.

---

## 1. Audit of the existing repository

### 1.1 Backend

- **No billing, no plan, no subscription code exists.** Searches for
  `subscription`, `billing`, `entitlement`, `quota`, `checkout`, `stripe`,
  `paddle`, `chargebee` all return zero matches in `src/`. No payment
  dependencies in `package.json`.
- **Tenant model (`src/models/Tenant.js`)** already carries:
  `planId` (string), `billingEmail`, `country`, `defaultCurrency`,
  `trialEndsAt`. These are populated at tenant creation and surfaced
  read-only via `tenantService.billing()` which returns
  `{ tenantId, planId, status, billingEmail, defaultCurrency, trialEndsAt,
  hasHistory: false }` — explicitly marked "Billing is a later-phase
  deliverable".
- **MasterData model** is the existing reference-data catalogue and is
  reusable as the storage for the plan catalogue. It is platform-wide
  (not tenant-scoped) and partitioned by `catalogue`. The existing
  `catalogue: 'plans'` partition is the canonical plan storage and the
  existing `masterDataService` already supports list/get/create/update/
  softDelete with audit and optimistic concurrency. The repository
  enforces a `[a-z0-9_]+` catalogue key and an `isSystem` flag that
  blocks deletion of platform-bound rows. **Phase 6 will reuse this and
  introduce a structured `data` payload for plan entries**; it will not
  fork a new collection.
- **Setting model** has `scope: 'platform' | 'tenant'` and is the
  existing hot-reloadable typed configuration surface. Phase 6 uses it
  for runtime billing toggles (grace period, trial length default,
  payment-provider adapter selection) without inventing a second config
  system.
- **FeatureFlag model** is a separate platform-wide gating surface.
  Phase 6 **does not** reuse it for plan features; entitlements are a
  distinct concern (resolved from the plan + subscription, not from a
  flag).
- **Permission model + RBAC** is the existing canonical authorisation
  surface. Phase 6 will register new permission keys under module
  `iam.subscriptions` (workspace scope) and `billing` (platform scope)
  and reuse the existing role seeding, permission gating and
  `permission()` middleware.
- **AuditLog / AccessLog** are the existing audit surfaces. Phase 6
  emits `iam.subscriptions.*` and `billing.*` audit events through the
  same `auditLogService.emit()` channel as every other privileged write.
- **Existing route surface** is mounted in `src/routes/index.js`. Phase
  6 adds new routers under `/api/v1/tenants/:id/subscription`,
  `/api/v1/admin/plans`, `/api/v1/admin/subscriptions`, and
  `/api/v1/admin/entitlements`. No public registration or onboarding
  path is touched.
- **Existing tenant lifecycle** (`pending → active → suspended | disabled
  → archived`) is owned by `tenantLifecycle.service.js` and is the
  distinct *tenant operational lifecycle*. Phase 6 introduces a separate
  *subscription lifecycle* (Section 3) on top; the two are decoupled and
  resolved by the entitlement service.

### 1.2 Frontend

- **No billing/subscription route or component exists.** The router
  contains `admin.tenants.tsx`, `admin.tenants.$tenantId.tsx`,
  `admin.dashboard.tsx` etc., but no `billing.*` or `subscription.*`
  route.
- **Permission catalogue (`src/lib/permissions/index.ts`)** is the
  existing client-side UX gate. Phase 6 adds `BILLING_*` and
  `IAM_SUBSCRIPTIONS_*` keys mirroring the backend contract.
- **React Query + the existing `useAdminSession()` / `useAuthSession()`
  session hooks** are reused; no new client-side state library is
  introduced.
- **Existing design system** (`src/components/ui/*`,
  `EmptyState`/`ErrorState`/`TableSkeleton`) is reused for all new
  surfaces.

### 1.3 Phase 5 carry-over (NOT closed by Phase 6)

- MFA audit-event emission (`mfa.service.js` / `mfa.controller.js` do
  not call `auditLogService.emit` for enroll/verify/disable).
- Support impersonation start/stop UI (the API is intact and covered
  by `tests/support.integration.test.js`; only the UI surface is
  incomplete).

These are recorded in the Phase 5 report and remain open.

---

## 2. Existing functionality versus gaps

| Area | Existing | Gap |
|---|---|---|
| Plan storage | `MasterData` `catalogue: 'plans'` partition | No structured entitlement schema; no marketing/entitlement split; no validation of limit shapes |
| Tenant billing facts | `tenantService.billing()` reads Tenant fields and returns `{ planId, status, billingEmail, defaultCurrency, trialEndsAt, hasHistory:false }` | No subscription row, no lifecycle, no entitlement resolution, no usage |
| Subscription state | None | No subscription document, no state machine, no transitions, no audit |
| Entitlement resolution | None | No service, no central authority, no fail-safe defaults |
| Quota enforcement | None | Connectors / Dashboards / Reports / Alerts / Users are *uncapped*; an `if (count > 5)` style guard does not exist anywhere today |
| Usage metering | `tenantStatistics.service.js` provides ad-hoc counts (users, sessions, audit events) but no period, no reset, no quotas | No per-tenant usage document, no per-period reset, no integration with write paths |
| Owner self-service | Workspace Owner role exists; no subscription page | No subscription surface |
| Platform Admin plan mgmt | None — admin tenant pages exist; no plan page | New surface required |
| Audited overrides | No override model | New `EntitlementOverride` document required |
| Payment integration | None | Provider-neutral adapter required; no provider selected |

---

## 3. Canonical subscription lifecycle

Phase 6 introduces an explicit subscription state machine on top of
(but decoupled from) the existing tenant operational lifecycle.

### 3.1 States

```
                ┌──────────────┐
                │   trialing   │   trial period active; trialEndsAt in the future
                └──────┬───────┘
                       │ trial ends without payment
                       ▼
                ┌──────────────┐
        ┌──────▶│    active    │◀──── renew (paid period)
        │       └──────┬───────┘
        │              │ payment failed
        │              ▼
        │       ┌──────────────┐
        │       │ past_due     │  within grace period; reads continue, writes degrade
        │       └──────┬───────┘
        │              │ grace ends
        │              ▼
        │       ┌──────────────┐
        │       │  canceled    │  user-cancelled; remains usable until period end
        │       └──────┬───────┘
        │              │ period ends
        │              ▼
        │       ┌──────────────┐
        │       │  expired     │  read-only entitlement window; no new writes
        │       └──────┬───────┘
        │              │ admin override
        │              ▼
        │       ┌──────────────┐
        └───────│  restricted  │  emergency block; same as expired but by admin action
                └──────────────┘
```

### 3.2 Allowed transitions

Server-side `assertTransition(from, to)` in
`services/subscription.service.js` (the only place the graph lives):

| from | to | allowed | notes |
|---|---|---|---|
| trialing | active | yes | payment captured or admin extension |
| trialing | canceled | yes | user cancels before payment method on file |
| trialing | expired | yes | trialEndsAt reached with no payment |
| active | past_due | yes | payment failed, within grace |
| active | canceled | yes | user or admin cancels |
| past_due | active | yes | payment recovered |
| past_due | canceled | yes | user/admin cancels during grace |
| past_due | expired | yes | grace period elapsed |
| canceled | expired | yes | period end reached |
| canceled | active | yes | user re-subscribes before period end |
| expired | active | yes | user re-subscribes |
| expired | restricted | yes | admin action only |
| restricted | active | yes | admin action only |
| restricted | canceled | no | terminal until admin |
| `*` | `restricted` | yes (admin only) | emergency block |
| `*` | `*` | no | every other transition is rejected with 409 |

The same authority is used for workspace-self-service and platform-admin
mutations. The only difference is the permission gate (the role).

### 3.3 What is *not* a subscription state

- `pending` / `active` / `suspended` / `disabled` / `archived` are
  **tenant** operational states, owned by `tenantLifecycle.service.js`.
- Subscription states describe the **commercial relationship**; tenant
  states describe the **operational posture**. A tenant can be
  `archived` (operational) with a still-`active` subscription (no one
  is paying) — billing is decoupled from operations by design.

---

## 4. Data model

### 4.1 Plan catalogue (reuses `MasterData`)

`MasterData` row with `catalogue: 'plans'`, `code` = stable plan id
(e.g. `free`, `starter`, `pro`, `enterprise`), `name`, `data`:

```jsonc
{
  "displayName": "Pro",
  "description": "For growing teams",
  "status": "active",            // active | disabled | archived | deprecated
  "isSystem": true,              // blocks hard-delete at the repository
  "tier": 2,                     // ordinal for "upgrade" / "downgrade" UX hints
  "trialDays": 14,               // optional; null = no trial
  "graceDays": 7,                // optional; defaults to platform setting
  "features": {
    "dashboards": true,
    "reports": true,
    "alerts": true,
    "scheduled_reports": true,
    "audit_export": true,
    "sso": false,
    "embed": true,
    "webhook_connectors": true
  },
  "limits": {
    "members": { "max": 25, "hard": true },
    "connectors": { "max": 10, "hard": true },
    "dashboards": { "max": 50, "hard": false },
    "reports": { "max": 50, "hard": false },
    "alerts": { "max": 25, "hard": true },
    "scheduledReports": { "max": 10, "hard": true },
    "storedRows": { "max": 1000000, "hard": true },
    "apiCallsPerDay": { "max": 50000, "hard": true }
  }
}
```

Validation: every limit MUST be `{ max: number >= 0, hard: boolean }`;
negative `max` is rejected. `features` MUST be a flat object of
booleans. `status` MUST be one of the four values. Plan `code` is
immutable once published; renaming goes through `displayName`.

A **new** `Plan` service layer (`services/plan.service.js`) wraps
`masterDataService` so that callers see a typed shape, not a generic
`{ catalogue, code, data }` blob. The platform seed file
`seeds/plan-catalog.seed.js` (idempotent, like the existing 21-module
seed) populates the four plans above with the limit numbers above as
the **initial** catalogue. The numbers are **defaults**, not commercial
pricing: `displayName` is the only marketing field; there is no
`price`, no `currency`, no `interval`. Payment provider integration is a
deliberate, documented gap (Section 9).

### 4.2 Subscription document (new)

`models/Subscription.js`:

| field | type | notes |
|---|---|---|
| `tenantId` | String, required, unique | one subscription per tenant |
| `planId` | String, required | FK to `MasterData.code` in `plans` catalogue |
| `state` | String, required, enum | trialing \| active \| past_due \| canceled \| expired \| restricted |
| `trialEndsAt` | Date \| null | set on creation when `trialDays > 0` |
| `currentPeriodStart` | Date | period start |
| `currentPeriodEnd` | Date | period end; renewal target |
| `graceEndsAt` | Date \| null | when `state === past_due` |
| `canceledAt` | Date \| null | when the cancellation was recorded |
| `cancelAtPeriodEnd` | Boolean | `true` keeps service until `currentPeriodEnd` |
| `paymentProvider` | String \| null | e.g. `null` (Phase 6) / `stripe` (future) |
| `paymentReference` | String \| null | opaque provider id (NEVER raw card data) |
| `previousPlanId` | String \| null | for downgrade history |
| `previousState` | String \| null | for state-change history |
| `version` | Number | optimistic concurrency (inherited) |
| `createdBy`, `updatedBy` | String \| null | attribution |

Plugins: `optimisticConcurrency`, `paginate`, `audit (module:
'iam.subscriptions')`. **No** `tenantScope` — the subscription is the
single canonical record per tenant and the repository scopes by
`tenantId` explicitly so the service can answer "what is this tenant's
subscription" with one query.

A new `SubscriptionHistory` document (new) records every transition
appended-only for audit and is not exposed in API responses by default
(it is fetched only by the platform-admin timeline view).

### 4.3 Usage document (new)

`models/UsageCounter.js` — one document per `(tenantId, metric, period)`:

| field | type | notes |
|---|---|---|
| `tenantId` | String, required, index | |
| `metric` | String, required | `members`, `connectors`, `dashboards`, `reports`, `alerts`, `scheduledReports`, `storedRows`, `apiCallsPerDay` |
| `period` | String, required | `current` (for state-driven metrics) or ISO date `YYYY-MM-DD` / `YYYY-MM` (for cumulative metrics) |
| `value` | Number, default 0 | monotonically increasing for cumulative, current snapshot for state-driven |
| `kind` | String, required | `cumulative` \| `current` |
| `lastIncrementedAt` | Date | |
| `lastReconciledAt` | Date \| null | periodic reconciliation against authoritative collection |

Compound unique index: `{ tenantId: 1, metric: 1, period: 1 }`. The
repository uses `findOneAndUpdate({...}, { $inc: { value: 1 } }, {
upsert: true })` to make increment **atomic**; the caller never
reads-then-writes. This is the safe check-then-write boundary the plan
calls for.

### 4.4 Entitlement override (new)

`models/EntitlementOverride.js` — one per override:

| field | type | notes |
|---|---|---|
| `tenantId` | String, required, index | |
| `metric` | String \| null | null = applies to the whole entitlement set; otherwise names a single feature/limit |
| `kind` | String | `feature` \| `limit` |
| `value` | Mixed | boolean (feature) or `{ max, hard }` (limit) |
| `reason` | String, required | admin must supply a reason |
| `expiresAt` | Date \| null | null = non-expiring; reconciliation job will not auto-revoke but expiry is honored on read |
| `grantedBy` | String, required | admin id |
| `revokedAt` | Date \| null | soft revoke; revoked rows are kept for audit |
| `revokedBy` | String \| null | |
| `revokeReason` | String \| null | |

Plugins: `audit (module: 'iam.entitlements')`, `optimisticConcurrency`.

### 4.5 Cache

Entitlement results are cached **per request** via `entitlementCache`
(in-memory, request-scoped via `AsyncLocalStorage`). **Process-wide
caching is intentionally out of scope** for Phase 6 because the
permission to invalidate is exactly the case where staleness hurts the
most and a single in-process cache would have to fan-out across
workers. Each call resolves the canonical subscription + plan + active
overrides in two queries. After every subscription change, plan change
or override write, the relevant call paths (the ones performing the
write) re-read the entitlement on the next request. This is sufficient
because entitlements are read-mostly and a single stale read per
mutation is operationally acceptable; the alternative (a fan-out
invalidation bus) is a Sprint N task.

---

## 5. Initial entitlement and quota catalogue

Phase 6 ships **only the quotas the application actually enforces
today or in this phase**. Invented quotas are not introduced.

| Metric | Kind | Reset | Hard? | What counts |
|---|---|---|---|---|
| `members` | current | n/a | yes | non-deleted users with `status: 'active'` |
| `connectors` | current | n/a | yes | non-soft-deleted `Connector` rows |
| `dashboards` | current | n/a | yes (limit `soft: false` upgrades to warning) | non-soft-deleted `Dashboard` rows |
| `reports` | current | n/a | no (warning) | non-soft-deleted `Report` rows |
| `alerts` | current | n/a | yes | non-soft-deleted `AlertRule` rows |
| `scheduledReports` | current | n/a | yes | reports with `schedule.enabled === true` |
| `storedRows` | current | n/a | yes | sum of `ConnectorRow.count` across non-deleted connectors |
| `apiCallsPerDay` | cumulative | daily 00:00 UTC | yes | counted at the `/external/*` route boundary; idempotent retries are de-duped by `X-Idempotency-Key` |

`features` (no limit) are booleans on the plan: `dashboards`,
`reports`, `alerts`, `scheduled_reports`, `audit_export`, `sso`,
`embed`, `webhook_connectors`. Each maps to a permission gate that
the existing `permission()` middleware already understands; missing
feature → 403 (NOT 429). For example, a tenant without `sso` cannot
reach the SSO endpoints because the route is permission-gated
(`sso.configure`) — the entitlement service is **not** on the request
hot path for the "is this feature enabled" question; it is the
authoritative source for the *plan-aware* admin override.

### 5.1 Hard vs soft

- **Hard** limit → write returns `409 QUOTA_EXCEEDED` with a stable
  `code` and a structured body:
  `{ code: 'QUOTA_EXCEEDED', metric, limit, current, hard: true }`.
- **Soft** (warning) limit → write succeeds; a `Warning` header is
  added (`X-Quota-Warning: dashboards=55/50`) and an audit event of
  type `quota.warning` is recorded. Reads continue to be authoritative
  from `tenantStatistics`.

---

## 6. Usage accounting

### 6.1 State-driven metrics (members, connectors, dashboards, reports, alerts, scheduledReports, storedRows)

These are **current-state counts**. The increment is *creation* and the
decrement is *soft-delete*; the reconciliation job (cron, every 15
minutes, documented in `src/docs/JOBS.md`) re-syncs the counter from
the authoritative collection. Reconciliation is additive only on
`storedRows` (because row counts can decrease when a connector row is
re-ingested) and is **set-to-actual** on the other counters. The
`value` is updated with `findOneAndUpdate({ tenantId, metric, period:
'current' }, { $set: { value: actual, lastReconciledAt: now } },
{ upsert: true })`.

### 6.2 Cumulative metrics (apiCallsPerDay)

`apiCallsPerDay` is the only cumulative metric. It is incremented in
the existing `/external/*` route boundary (after successful
authentication, before the handler), using
`findOneAndUpdate({ tenantId, metric, period: today, kind: 'cumulative' },
{ $inc: { value: 1 }, $set: { lastIncrementedAt: now } }, { upsert:
true })`. **Idempotency:** when the request carries
`X-Idempotency-Key`, the call is routed through the existing
`idempotencyKey.service` (Sprint 9) and counted only on first execution.
Retries that hit a 5xx and retry **do not** double-count. Background
job retries (none today) follow the same rule.

### 6.3 Reset policy

- `apiCallsPerDay` is daily at 00:00 UTC. The daily cron is idempotent:
  it creates today's document and lets yesterday's row age out
  (the metric is keyed by `period = today`, so "reset" is implicit in
  the period key changing).
- A reconciliation job (every 15 minutes) keeps the state-driven
  counters within 15 minutes of authoritative reality, which is fast
  enough for the UI and slow enough not to be a hot path. The job
  also reconciles `storedRows` additively.

### 6.4 Stable error shape

```jsonc
HTTP/1.1 409 Conflict
Content-Type: application/json
{
  "code": "QUOTA_EXCEEDED",
  "message": "Plan limit reached for connectors (max 10).",
  "details": { "metric": "connectors", "limit": 10, "current": 10, "hard": true }
}
```

The UI reads `details` to render a specific, actionable upgrade prompt.

---

## 7. Tenant isolation and authorisation

### 7.1 Workspace Owner self-service

- Permission gate: the existing `Owner` role. New permission keys
  registered:
  - `iam.subscriptions.view`
  - `iam.subscriptions.update` (change plan, cancel)
  - `iam.subscriptions.read.invoices` (Phase 6 returns a synthetic
    empty list — see Section 9.2)
  - `iam.entitlements.view`
- The `Owner` role is auto-granted every new key during
  `tenantInitialization.initialize` (the existing pattern).
- The tenant identity is **always** derived from the authenticated
  session (`req.user.tenantId`), not from a body field. The
  `tenantIsolation` middleware already enforces this for
  tenant-scoped routes; the new subscription router reuses it.

### 7.2 Platform Admin

- Permission gate: a new `billing` module with platform-only
  permission keys:
  - `billing.plans.view` — required to list/read plans.
  - `billing.plans.create` / `billing.plans.update` /
    `billing.plans.archive` — only `super` may mutate plans; `platform`
    can read.
  - `billing.subscriptions.view` — list/inspect.
  - `billing.subscriptions.override` — explicit override write.
  - `billing.entitlements.override` — create/revoke overrides.
- Default support role is **read-only** (no `*.override` keys
  granted). This is enforced by the default role-seed which is the
  existing canonical role list.
- Workspace APIs (`/tenants/:id/subscription`) do not accept the
  `billing.*` keys; they remain `iam.subscriptions.*`. Workspace Admin
  cannot mutate platform-wide plans even by passing a body field — the
  plan router lives under `/admin/*` and requires `adminAuth`.

### 7.3 Override scope

- Overrides are tenant-scoped (a row carries `tenantId`).
- An override cannot grant more than the *highest* plan's hard limit
  for the same metric. This is enforced server-side: the override
  service clamps the requested `max` to
  `max(highest_plan.limit.max, current_plan.limit.max) * OVERRIDE_SAFETY_FACTOR`
  where `OVERRIDE_SAFETY_FACTOR = 1000` (a safety net against
  accidental "unlimited" grants). The default for `value` is rejected
  if it is `null` or negative.
- Overrides require a non-empty `reason` and are audit-logged
  (`iam.entitlements.override.created` and `.revoked`).

### 7.4 Cross-tenant isolation

- Subscription reads/writes go through the existing tenant scope; a
  workspace user with role in tenant A cannot read tenant B's
  subscription because the `tenantIsolation` middleware rejects
  mismatched routes.
- A platform admin's "view another tenant's subscription" goes through
  `/admin/subscriptions/:tenantId` with the `adminAuth` middleware; the
  payload is the same shape but the response excludes payment
  references (or returns a redacted placeholder if any) and is audit
  logged (`billing.subscriptions.viewed`).

---

## 8. Migration and backward compatibility

- **Existing tenants keep working** on Phase 6 with no data migration.
  The plan catalogue is read first; if the catalogue is empty (fresh
  install or un-seeded environment) the entitlement service applies a
  safe `default` plan that ships in code (the same as the seed
  default). This means a new entitlement check on an old tenant never
  throws "no plan configured".
- **Existing `tenant.planId` field** is read on first entitlement
  resolution. If `tenant.planId` is set and the catalogue contains a
  matching plan, the tenant is *migrated* to a subscription row
  (idempotent upsert by `tenantId`) in the `active` state on the
  indicated plan, with `currentPeriodStart = now - 30d` and
  `currentPeriodEnd = now + 30d` so the existing UX ("you are on Pro")
  continues to be true. If the catalogue does not contain the plan
  (renamed/removed plan) the tenant is migrated to the `default` plan
  and an audit event `iam.subscriptions.migrated` is recorded with the
  previous `planId` and the new plan id. **No data is ever deleted.**
- **Existing billing facts endpoint** (`GET /tenants/:id/billing`)
  keeps its current response shape; Phase 6 *adds*
  `GET /tenants/:id/subscription` and `GET /tenants/:id/usage` rather
  than mutating the old shape. The old endpoint becomes a thin
  projection of the new subscription.
- **Existing routes for tenant admin / settings / members / onboarding
  / invitations are not changed.**

### 8.1 Rollback

A single feature flag (existing `FeatureFlag` model) `billing.v1.enabled`
(default `true`) is honored at the route mount. Setting it to `false`
at the platform level makes the new routers 404 without taking the
legacy `billing` facts endpoint down. This is reversible per request
without a deployment.

---

## 9. Payment integration boundary (deferred)

### 9.1 No provider selected

Phase 6 ships **no** payment provider. There is no `stripe`, `paddle`,
`braintree` or `chargebee` dependency in `package.json`. The plan
catalogue has **no** `price`, no `currency` and no `interval` field;
introducing those would invent a commercial commitment that does not
yet exist.

### 9.2 What is implemented as a boundary

A new `services/paymentProvider.adapter.js` exposes a single object:

```js
{
  name: 'noop',           // the only registered provider in Phase 6
  async createCheckoutSession({ tenantId, planId, successUrl, cancelUrl }) {
    throw new ApiError(501, 'CHECKOUT_UNAVAILABLE',
      'Checkout is not yet available. Contact support to change plans.');
  },
  async handleWebhook(req) { return { handled: false }; },
  async cancel({ providerRef, at }) { return { canceled: true }; },
  async reconcile({ tenantId }) { return []; }
}
```

The router `POST /admin/subscriptions/:tenantId/checkout` calls
`createCheckoutSession` and returns the 501 honestly. The Workspace
Owner's "Upgrade" button renders a "Checkout is not yet available"
empty state. **No fake success page, no fake invoice, no fake renewal
date.**

### 9.3 What is still required (deferred)

- Provider selection (Stripe / Paddle / Chargebee / Adyen / …).
- Final commercial pricing and billing intervals.
- Tax, VAT, invoice numbering policy.
- Refund policy.
- Payment-failure and grace-period rules.
- Webhook endpoint and signature verification (provider-specific).
- Server-side `entitlementService.applyPaymentEvent(providerRef, event)`
  implementation.
- Production configuration of provider API keys (env-only, never
  committed).

These are recorded as "Decisions still required" in the report and
are NOT addressed by Phase 6.

### 9.4 Webhook contract (when implemented)

The contract is fixed now so a future provider fits without
re-designing the entitlement side:

```js
// Verified at the route layer by the provider's official signature
// mechanism; the body is normalised to this shape before reaching
// the service.
{
  type: 'payment.succeeded' | 'payment.failed' | 'subscription.created' |
        'subscription.canceled' | 'subscription.renewed',
  provider: 'stripe' | 'paddle' | ...,
  providerRef: string,                 // opaque
  tenantId: string,                    // required; the adapter resolves this
  planId: string | null,               // proposed new plan
  amountMinor: number | null,          // not used by Phase 6
  currency: string | null,             // not used by Phase 6
  occurredAt: ISODate,                 // provider timestamp
  idempotencyKey: string               // mandatory; used to dedupe
}
```

The adapter MUST be idempotent on `idempotencyKey`. The handler MUST
verify signatures **before** any state change. Out-of-order events are
accepted; the service uses the most recent `occurredAt` per
`tenantId + type`.

---

## 10. Implementation stages and acceptance criteria

### Stage 1 — Plan catalogue (Reuse MasterData)
- New `src/services/plan.service.js` wrapping `masterDataService`.
- New `src/validators/plan.validator.js` enforcing
  `{ max: number >= 0, hard: boolean }` and feature booleans.
- New `src/seeds/plan-catalog.seed.js` (idempotent) called from the
  existing seed bootstrap.
- **Acceptance:** a fresh DB has 4 plan rows; an existing DB is
  untouched; listing returns stable shape.

### Stage 2 — Subscription lifecycle
- New `src/models/Subscription.js`,
  `src/models/SubscriptionHistory.js`,
  `src/repositories/subscription.repository.js`,
  `src/services/subscription.service.js`.
- New `src/validators/subscription.validator.js`.
- `assertTransition(from, to)` is the only authority for the graph.
- New routes `GET/POST/PATCH /tenants/:id/subscription` and
  `POST /tenants/:id/subscription/cancel` under workspace auth.
- Concurrent update safety via `optimisticConcurrency`.
- **Acceptance:** every legal transition succeeds once; every illegal
  transition returns 409.

### Stage 3 — Centralised entitlement service
- New `src/services/entitlement.service.js` exposing
  `resolveEffective(tenantId)`, `can(tenantId, feature)`,
  `checkLimit(tenantId, metric, requested?)`.
- Fail-safe default plan (the `default` plan in the seed catalogue)
  is applied when the subscription is missing or malformed.
- **Acceptance:** missing/malformed subscription does NOT grant
  unlimited access; feature/limit lookups return a typed shape;
  client-supplied plan fields are ignored.

### Stage 4 — Usage metering and quota enforcement
- New `src/models/UsageCounter.js` and
  `src/repositories/usageCounter.repository.js` with atomic
  `incrementOrCreate` and `setToActual`.
- New `src/services/usage.service.js` with `getUsage(tenantId)` and
  `checkAndConsume({ tenantId, metric, requested })`.
- Enforcement wrappers added at the authoritative write boundaries:
  connectors (create), dashboards (create), reports (create), alert
  rules (create), external API (per-call), tenant members (invite).
- A reconciliation job (Sprint N) is stubbed in
  `src/jobs/usageReconciliation.job.js` and runs on a 15-minute
  interval when the server is started; tests verify the *function*,
  not the cron.
- **Acceptance:** at the limit, a write returns 409 with the stable
  error shape; concurrent writes at the boundary cannot exceed the
  limit by more than one (atomic `$inc` + `upsert`).
- **Acceptance:** retries on the external API do not double-count
  (idempotency-key integration).

### Stage 5 — Workspace Owner subscription experience
- New `src/controllers/subscription.controller.js` (workspace side).
- Frontend: new `src/routes/billing.tsx` (Owner-only, gated by
  `Permissions.IAM_SUBSCRIPTIONS_VIEW`); new
  `src/features/billing/components/SubscriptionPanel.tsx`;
  `src/features/billing/api/index.ts` (typed `react-query` hooks).
- "Upgrade" button shows honest "Checkout is not yet available"
  state. No fake payment success.
- **Acceptance:** the route is reachable only as Owner; the UI shows
  plan, current usage vs limits, and the upgrade prompt; tests prove
  that workspace Admin / Manager / Viewer cannot reach the page.

### Stage 6 — Platform Admin plan and subscription management
- New `src/controllers/adminPlan.controller.js` and
  `adminSubscription.controller.js` and
  `adminEntitlement.controller.js`.
- New routes under `/admin/plans`, `/admin/subscriptions`,
  `/admin/entitlements`. All require `adminAuth`. Mutations require
  the explicit `billing.plans.*` / `billing.subscriptions.override` /
  `billing.entitlements.override` keys.
- Override writes require `reason` and audit-log the
  `actor / target / previousValue / newValue / reason / occurredAt`.
- Frontend: new `src/routes/admin.plans.tsx` and
  `admin.subscriptions.tsx` and `admin.entitlements.tsx`; new
  `src/features/admin/components/PlanViews.tsx` with the same
  patterns as the existing `AdminViews.tsx`.
- **Acceptance:** every privileged write is permission-gated,
  audit-logged, and the override cannot grant more than the safety
  factor.

### Stage 7 — Payment integration boundary
- `src/services/paymentProvider.adapter.js` (no-op provider only).
- `src/routes/billing-webhook.routes.js` (no-op handler returning
  501; documented as the integration point).
- **Acceptance:** the route is registered, returns 501 honestly, and
  the noop adapter is the only registered provider.

### Stage 8 — API contracts, UI states, and documentation
- Update `src/docs/API.md` (or canonical equivalent) with the new
  endpoints, error shapes, and idempotency rules.
- Update `frontend/src/docs/INTEGRATION.md` with the new typed
  client surface.
- UI uses the existing `EmptyState` / `ErrorState` / `TableSkeleton`
  / `DataTable` components throughout.

### Stage 9 — Tests
- Per-stage unit + integration tests for the new services and routes.
- New tests in `tests/billing-*.integration.test.js`:
  - Concurrent writes at quota boundary.
  - Idempotent retry of `apiCallsPerDay`.
  - Cross-tenant isolation.
  - Missing subscription does not grant unlimited access.
  - Override expiry / revocation.
  - Workspace Owner vs other roles; cross-portal isolation.
  - Last super admin guard (already present, kept) is unchanged.
  - Payment boundary: checkout returns 501; webhook returns 501.
- Run twice, then `npm run ci:guards`, then frontend
  `npm test` / `tsc --noEmit` / `npm run lint` / `npm run build`.
- `git diff --check` clean in both repos.

### Stage 10 — Reports
- `docs/PHASE_6_BILLING_PLAN.md` (this file).
- `docs/PHASE_6_BILLING_REPORT.md` with the same structure as
  Phase 5 (existing functionality, files changed, schemas,
  entitlement rules, quota definitions, concurrency strategy, API
  contracts, authorization, migration, exact test commands and
  results, payment-provider decisions still required, production
  configuration, known limitations and deferred work, including
  the still-open Phase 5 gaps).

---

## 11. Testing, rollback, and production-readiness

- **Testing:** the project already uses Node `--test` with
  `mongodb-memory-server`. New tests follow the same pattern (see
  `tests/tenant.service.test.js`, `tests/admin-bootstrap.service.test.js`).
  All new code is reachable from at least one integration test; the
  entitlement service and the quota enforcement are tested under
  concurrency with `Promise.all` of 5–20 writes.
- **Rollback:** the `billing.v1.enabled` flag returns the new routes
  to 404; the legacy `GET /tenants/:id/billing` endpoint remains.
  Per-tenant overrides can be revoked in bulk via a documented admin
  script (`scripts/revoke-all-overrides.js`, dry-run by default).
- **Production-readiness requirements still pending:**
  - Provider selection and contract sign-off.
  - Commercial pricing decision.
  - VAT/tax and invoice numbering policy.
  - Production secrets for the provider (env-only).
  - Rate-limit policy for `/external/*` documented in
    `docs/PHASE_6_BILLING_REPORT.md`.
  - The reconciliation job is wired to a real cron in production
    (the implementation is the same; the deploy step is out of
    scope for this phase).

---

## 12. Production configuration

Phase 6 introduces no new environment variables at runtime; the
entitlement and quota resolution are deterministic from the catalogue
and the subscription rows. The future provider integration will need
`BILLING_PROVIDER_API_KEY` etc.; these are **not** added in Phase 6
and are recorded as "decisions still required" in Section 9.3.

---

## 13. Known limitations and deferred work

- No payment provider. (Section 9.)
- No real invoice generation; the Owner "Invoices" tab returns an
  honest empty state.
- No tax/VAT handling.
- No automatic dunning emails on `past_due`; the UI surfaces the
  state but does not dispatch emails. The reconciliation job is
  single-tenant and does not yet email.
- `storedRows` reconciliation is additive only; a hard purge of
  connector rows is out of scope.
- Process-wide entitlement cache is out of scope (see Section 4.5).
- The Phase 5 gaps (MFA audit-event emission; support impersonation
  start/stop UI) are still open and are NOT addressed by Phase 6.

---

## 14. Definition-of-Done checklist (will be re-validated in the report)

1. ✅ Every implemented plan and quota has a documented authoritative
   definition (Section 4 + Section 5).
2. ✅ Effective entitlements are resolved centrally
   (`entitlement.service.js`).
3. ✅ Quotas are enforced on the backend at the write boundary under
   concurrent requests (atomic `$inc` + `upsert`).
4. ✅ Subscription lifecycle transitions are validated and audited.
5. ✅ Workspace Owners can inspect and manage only their own tenant's
   permitted subscription settings.
6. ✅ Platform Admin actions enforce the existing permission model and
   emit audit events.
7. ✅ Existing tenants remain compatible through the documented
   migration/default policy.
8. ✅ Tests and build gates pass (Stage 9).
9. ✅ Payment-provider integration is accurately marked deferred.
10. ✅ No customer is charged and no production billing state is
    changed.
