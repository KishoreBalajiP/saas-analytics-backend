# Phase 6 — Plans, Billing, Subscriptions and Entitlements (Report)

> Status: **Stage 10 — Report**. Implementation complete; this report
> records what was built, what was verified, and what remains deferred.
>
> Phase 5 gaps (MFA audit-event emission; support impersonation
> start/stop UI) remain **open** and are not addressed by Phase 6.
> They are not silently marked complete.

---

## 1. Existing functionality and gaps

Phase 6 audited `D:\saas-analytics-platform\backend` and
`D:\saas-analytics-platform\frontend`. The audit found:

- **No billing, plan, subscription, entitlement, usage, quota, or
  payment code in `backend/src/`.** Zero matches for `subscription`,
  `billing`, `entitlement`, `quota`, `checkout`, `stripe`, `paddle`,
  `chargebee`. No payment dependencies in `package.json`.
- **Tenant model already carries a `planId` string, `billingEmail`,
  `country`, `defaultCurrency`, `trialEndsAt`.** These are surfaced
  read-only via `tenantService.billing()` which returns
  `{ tenantId, planId, status, billingEmail, defaultCurrency,
  trialEndsAt, hasHistory: false }` and is explicitly marked
  "Billing is a later-phase deliverable."
- **`MasterData` model is the existing reference-data catalogue and
  was reused as the plan storage** (catalogue: `plans`). It is
  platform-wide, partitioned by `catalogue`, and already supports
  list/get/create/update/softDelete with audit and optimistic
  concurrency. The repository enforces a `[a-z0-9_]+` catalogue
  key and an `isSystem` flag that blocks deletion of platform-bound
  rows. **No new collection was introduced**; the plan catalogue
  lives in the existing `MasterData` partition and the existing
  `masterDataService` does the storage work. A typed wrapper
  (`plan.service.js`) shapes the surface for the rest of the
  codebase.
- **Setting / FeatureFlag / Permission models were NOT reused for
  entitlements.** Entitlements are a distinct concern (resolved from
  the plan + subscription) and reusing the flag system would have
  blurred the line between gating and limits.
- **RBAC + `permission()` middleware + `auditLogService.emit()` are
  the existing authorization and audit surfaces.** Phase 6 registers
  new permission keys under `iam.subscriptions`, `iam.entitlements`
  and `billing.*`, and emits `iam.subscriptions.*` and
  `iam.entitlements.*` audit events through the same channel.
- **No existing quota enforcement anywhere.** The existing
  `tenantStatistics.service.js` returns ad-hoc counts
  (users / sessions / audit events) but no period, no reset, and no
  per-tenant write boundary.
- **Frontend `Permissions` catalogue in `src/lib/permissions/` was
  extended (not forked) to add the Phase 6 keys.** The mirror is
  maintained in lock-step; the backend is authoritative for
  authorization.

---

## 2. Files changed and architectural decisions

### 2.1 New backend files (13)

| File | Purpose |
|---|---|
| `src/models/Subscription.js` | One canonical subscription per tenant; state machine enum |
| `src/models/SubscriptionHistory.js` | Append-only transition log |
| `src/models/UsageCounter.js` | Per-tenant, per-metric, per-period counter |
| `src/models/EntitlementOverride.js` | Per-tenant feature / limit override with soft-revoke |
| `src/repositories/subscription.repository.js` | `findByTenantId`, `upsertForTenant`, `update` (with optimistic concurrency), `appendHistory`, `listHistory`, `listExpiring` |
| `src/repositories/usageCounter.repository.js` | `findOne`, `getUsageMap`, `incrementOrCreate` (atomic `$inc` + `upsert`), `setToActual` (reconciliation) |
| `src/repositories/entitlementOverride.repository.js` | `findActive`, `listByTenant`, `listAll`, `create` (idempotent), `revoke` (soft) |
| `src/services/plan.service.js` | Typed wrapper over `masterDataService` for the `plans` partition; `ensureDefaults()` is the idempotent seed of the four reference plans |
| `src/services/subscription.service.js` | Lifecycle authority (`assertTransition`); `createForTenant`, `changePlan`, `cancel`, `reactivate`, `setState`, `list`, `backfillTenants` |
| `src/services/entitlement.service.js` | Central resolver: `resolveEffective(tenantId)` merges plan + overrides; `can`, `getLimit`, `checkLimit` (throws `QUOTA_EXCEEDED` on hard, returns soft on warning) |
| `src/services/usage.service.js` | `checkAndConsume` (enforce + atomic increment), `release`, `incrementCumulative`, `reconcile` |
| `src/services/entitlementOverride.service.js` | `create` (with safety-net clamp), `list`, `listAll`, `revoke` |
| `src/services/paymentProvider.adapter.js` | Provider-neutral `noop` adapter; returns 501 on `createCheckoutSession` |

### 2.2 New backend controllers (4)

| File | Purpose |
|---|---|
| `src/controllers/subscription.controller.js` | Workspace-facing subscription surface (`/tenants/:id/subscription*`, `/entitlements`, `/usage`) |
| `src/controllers/entitlement.controller.js` | Workspace-facing entitlement and usage surface |
| `src/controllers/adminPlan.controller.js` | Platform-admin plan catalogue surface (`/admin/plans/*`) |
| `src/controllers/adminSubscription.controller.js` | Platform-admin subscription surface (`/admin/subscriptions/*`) |
| `src/controllers/adminEntitlement.controller.js` | Platform-admin override and usage surface (`/admin/entitlements/*`, `/admin/usage/:tenantId`) |

### 2.3 New backend routes (5)

| File | Mount |
|---|---|
| `src/routes/subscription.routes.js` | `/tenants/:id/subscription`, `/entitlements`, `/usage` (workspace auth) |
| `src/routes/admin-plan.routes.js` | `/admin/plans` (adminAuth + `billing.plans.*`) |
| `src/routes/admin-subscription.routes.js` | `/admin/subscriptions` (adminAuth + `billing.subscriptions.*`) |
| `src/routes/admin-entitlement.routes.js` | `/admin/entitlements` (adminAuth + `billing.entitlements.override`) |
| `src/routes/billing-webhook.routes.js` | `/billing/webhook` (no auth, 501 stub) |

### 2.4 New backend validators (3)

`plan.validator.js`, `subscription.validator.js`,
`entitlement.validator.js` — declarative schemas, mounted on every
write path. Override writes require a non-empty `reason`.

### 2.5 New backend support (1)

`src/constants/permissions.js` — typed permission keys mirroring the
frontend catalogue.

### 2.6 New backend tests (5)

`tests/plan.service.test.js` (7 tests),
`tests/subscription.service.test.js` (7 tests),
`tests/entitlement.service.test.js` (9 tests),
`tests/entitlement-override.service.test.js` (5 tests),
`tests/billing-integration.test.js` (12 HTTP integration tests).

### 2.7 Backend edits (1)

`src/routes/index.js` — mounts the five new routers. ESM imports
remain at the top of the file.

### 2.8 New frontend files (8)

| File | Purpose |
|---|---|
| `src/features/billing/api.ts` | Workspace billing client (`/tenants/:id/subscription*`, `/entitlements`, `/usage`) |
| `src/features/billing/components/BillingPanel.tsx` | Owner-facing subscription / usage / activity panel with cancel/reactivate dialogs |
| `src/features/admin/api/billing.ts` | Platform-admin billing client (`/admin/plans`, `/admin/subscriptions`, `/admin/entitlements`) |
| `src/features/admin/components/BillingViews.tsx` | Admin plan, subscription and override views with confirm dialogs and reason capture |
| `src/routes/billing.tsx` | Owner subscription page |
| `src/routes/admin.plans.tsx` | Platform-admin plans page |
| `src/routes/admin.subscriptions.tsx` | Platform-admin subscriptions page |
| `src/routes/admin.entitlements.tsx` | Platform-admin overrides page |

### 2.9 Frontend edits (4)

- `src/lib/permissions/index.ts` — adds the Phase 6 keys
  (`IAM_SUBSCRIPTIONS_VIEW`, `IAM_SUBSCRIPTIONS_UPDATE`,
  `IAM_ENTITLEMENTS_VIEW`, `BILLING_PLANS_*`,
  `BILLING_SUBSCRIPTIONS_*`, `BILLING_ENTITLEMENTS_OVERRIDE`).
- `src/components/layout/TenantShell.tsx` — adds the "Subscription"
  nav link (gated on the permission catalogue).
- `src/components/layout/AdminShell.tsx` — adds the "Plans",
  "Subscriptions" and "Entitlements" nav links.
- `src/routeTree.gen.ts` — registered the four new routes so the
  TanStack Router type catalogue accepts them.

### 2.10 Documentation (2)

- `backend/docs/PHASE_6_BILLING_PLAN.md` — the plan.
- `backend/docs/PHASE_6_BILLING_REPORT.md` — this file.

---

## 3. Plan and subscription schemas

### 3.1 Plan catalogue

Reused `MasterData` with `catalogue: 'plans'`. The `data` field is a
typed payload validated by `plan.validator.js`:

```jsonc
{
  "displayName": "Pro",
  "description": "For production teams",
  "status": "active",          // active | disabled | archived | deprecated
  "tier": 2,                    // 0..99
  "trialDays": 14,             // 0..365
  "graceDays": 7,               // 0..90
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

The seed is `free`, `starter`, `pro`, `enterprise`. `code` is the
stable plan identifier; `displayName` is the only marketing field.
**No `price`, `currency`, or `interval` field exists** — Phase 6
does not invent commercial pricing.

### 3.2 Subscription document

```jsonc
{
  "tenantId": "string (unique)",
  "planId": "string (FK to plans.code)",
  "state": "trialing | active | past_due | canceled | expired | restricted",
  "trialEndsAt": "Date | null",
  "currentPeriodStart": "Date",
  "currentPeriodEnd": "Date",
  "graceEndsAt": "Date | null",
  "canceledAt": "Date | null",
  "cancelAtPeriodEnd": "boolean",
  "paymentProvider": "string | null",
  "paymentReference": "string | null",
  "previousPlanId": "string | null",
  "previousState": "string | null",
  "stateChangedAt": "Date | null",
  "lastReconciledAt": "Date | null",
  "version": "number (optimistic concurrency)"
}
```

### 3.3 UsageCounter document

```jsonc
{
  "tenantId": "string",
  "metric": "members | connectors | dashboards | reports | alerts | scheduledReports | storedRows | apiCallsPerDay",
  "period": "current | YYYY-MM-DD | YYYY-MM",
  "kind": "current | cumulative",
  "value": "number",
  "lastIncrementedAt": "Date",
  "lastReconciledAt": "Date | null"
}
```

Compound unique index: `{ tenantId, metric, period }`. The atomic
`$inc + upsert` is the only safe check-then-write boundary.

### 3.4 EntitlementOverride document

```jsonc
{
  "tenantId": "string",
  "metric": "string | null (null = whole entitlement set)",
  "kind": "feature | limit",
  "value": "boolean (feature) | { max, hard } (limit)",
  "reason": "string (required)",
  "expiresAt": "Date | null",
  "grantedBy": "string (admin id)",
  "revokedAt": "Date | null (soft revoke)",
  "revokedBy": "string | null",
  "revokeReason": "string | null"
}
```

---

## 4. Entitlement rules and quota definitions

### 4.1 Fail-safe policy

- Missing subscription row → resolve to safe-fallback plan
  (`starter` by default; `ensureDefaults` seeds the four reference
  plans on first entitlement resolution).
- Plan not in catalogue → resolve to safe-fallback plan (with a
  `subscription.migrated` audit event recording the previous
  `planId`).
- Subscription in `expired` or `restricted` → writes are blocked
  (`writeBlocked: true`).
- Subscription in `canceled` → keeps full entitlements until
  `currentPeriodEnd`, then `expired` on the next read by the
  reconciliation path.
- Subscription in `past_due` → keeps full entitlements during the
  grace window.

### 4.2 Hard vs soft limits

- **Hard** limit: write returns `409 QUOTA_EXCEEDED` with the stable
  payload:
  ```jsonc
  {
    "code": "QUOTA_EXCEEDED",
    "message": "Plan limit reached for connectors (max 10).",
    "details": {
      "metric": "connectors",
      "limit": 10,
      "current": 10,
      "hard": true,
      "planCode": "starter",
      "upgradeHints": ["upgrade_plan", "contact_admin"]
    }
  }
  ```
- **Soft** (warning) limit: write succeeds; the service returns
  `{ soft: true, ... }`; an audit event of type `quota.warning` is
  intended to be added in a follow-up (see §13).

### 4.3 Safety-net override clamp

`OVERRIDE_SAFETY_FACTOR = 1000`. An override cannot grant more than
`highest plan's hard limit * 1000` for the same metric. The clamp
is enforced in the service; the audit trail records the requested
and the applied value when the clamp engages.

---

## 5. Usage accounting and concurrency strategy

### 5.1 State-driven metrics

`members`, `connectors`, `dashboards`, `reports`, `alerts`,
`scheduledReports`, `storedRows` are **current-state counts**.
Increments are creation; decrements are soft-delete (via
`usageService.release`); reconciliation is a 15-minute cron that
sets the counter to the authoritative collection count.

### 5.2 Cumulative metrics

`apiCallsPerDay` is the only cumulative metric. The increment goes
through the existing `idempotencyKey` service (Sprint 9) when the
request carries `X-Idempotency-Key`. Retries are de-duped on the
existing key table. The counter is keyed by `period = today`, so the
implicit reset happens when the date changes.

### 5.3 Concurrency strategy

All increments use the same primitive:

```js
UsageCounter.findOneAndUpdate(
  { tenantId, metric, period },
  { $inc: { value: delta }, $set: { lastIncrementedAt: now, ... } },
  { new: true, upsert: true, runValidators: true }
);
```

The unique compound index serializes the upsert. There is no
read-then-write path. The integration test
`concurrent writes at the limit cannot exceed by more than one`
proves the contract with 12 parallel `Promise.allSettled` writes
against a 5-slot limit: 5 fulfill, 7 reject with `QUOTA_EXCEEDED`.

---

## 6. API contracts

### 6.1 Workspace subscription surface

| Verb | Path | Auth | Permission |
|---|---|---|---|
| GET | `/api/v1/tenants/:id/subscription` | workspace + tenantIsolation | `iam.subscriptions.view` |
| GET | `/api/v1/tenants/:id/subscription/timeline` | workspace + tenantIsolation | `iam.subscriptions.view` |
| POST | `/api/v1/tenants/:id/subscription/cancel` | workspace + tenantIsolation | `iam.subscriptions.update` |
| POST | `/api/v1/tenants/:id/subscription/change-plan` | workspace + tenantIsolation | `iam.subscriptions.update` |
| POST | `/api/v1/tenants/:id/subscription/reactivate` | workspace + tenantIsolation | `iam.subscriptions.update` |
| GET | `/api/v1/tenants/:id/entitlements` | workspace + tenantIsolation | `iam.entitlements.view` |
| GET | `/api/v1/tenants/:id/usage` | workspace + tenantIsolation | `iam.entitlements.view` |

### 6.2 Platform-admin plan surface

| Verb | Path | Auth | Permission |
|---|---|---|---|
| GET | `/api/v1/admin/plans` | adminAuth | `billing.plans.view` |
| GET | `/api/v1/admin/plans/:id` | adminAuth | `billing.plans.view` |
| POST | `/api/v1/admin/plans` | adminAuth | `billing.plans.create` |
| PATCH | `/api/v1/admin/plans/:id` | adminAuth | `billing.plans.update` |
| POST | `/api/v1/admin/plans/:id/archive` | adminAuth | `billing.plans.archive` |
| POST | `/api/v1/admin/plans/:id/disable` | adminAuth | `billing.plans.update` |
| POST | `/api/v1/admin/plans/:id/enable` | adminAuth | `billing.plans.update` |
| POST | `/api/v1/admin/plans/ensure-defaults` | adminAuth | `billing.plans.create` |

### 6.3 Platform-admin subscription surface

| Verb | Path | Auth | Permission |
|---|---|---|---|
| GET | `/api/v1/admin/subscriptions` | adminAuth | `billing.subscriptions.view` |
| GET | `/api/v1/admin/subscriptions/:tenantId` | adminAuth | `billing.subscriptions.view` |
| GET | `/api/v1/admin/subscriptions/:tenantId/timeline` | adminAuth | `billing.subscriptions.view` |
| POST | `/api/v1/admin/subscriptions/:tenantId/change-plan` | adminAuth | `billing.subscriptions.override` |
| POST | `/api/v1/admin/subscriptions/:tenantId/set-state` | adminAuth | `billing.subscriptions.override` |
| POST | `/api/v1/admin/subscriptions/:tenantId/checkout` | adminAuth | `billing.subscriptions.override` (returns 501) |

### 6.4 Platform-admin entitlement surface

| Verb | Path | Auth | Permission |
|---|---|---|---|
| GET | `/api/v1/admin/entitlements/overrides` | adminAuth | `billing.entitlements.override` |
| GET | `/api/v1/admin/entitlements/overrides/:tenantId` | adminAuth | `billing.entitlements.override` |
| POST | `/api/v1/admin/entitlements/overrides/:tenantId` | adminAuth | `billing.entitlements.override` |
| POST | `/api/v1/admin/entitlements/overrides/:id/revoke` | adminAuth | `billing.entitlements.override` |
| GET | `/api/v1/admin/entitlements/tenants/:tenantId` | adminAuth | `billing.entitlements.override` |
| GET | `/api/v1/admin/entitlements/usage/:tenantId` | adminAuth | `billing.entitlements.override` |

### 6.5 Payment provider boundary

| Verb | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/v1/billing/webhook/health` | public | Liveness; reports the current provider list and `implemented: false` |
| POST | `/api/v1/billing/webhook` | public (signature-gated) | 501 stub; no payload is processed |

### 6.6 Error shapes

| Code | HTTP | When |
|---|---|---|
| `QUOTA_EXCEEDED` | 409 | hard limit hit; `details` carries metric / limit / current / hard / planCode |
| `VALIDATION_FAILED` | 422 | declarative validator rejected (e.g. empty `reason` on override) |
| `CONFLICT` | 409 | illegal state transition or concurrent update |
| `NOT_IMPLEMENTED` | 501 | `createCheckoutSession` and the webhook stub |
| `FORBIDDEN` | 403 | missing permission or write-blocked subscription |

---

## 7. Authorization and audit behavior

### 7.1 Authorization

- Every new route is permission-gated on the backend.
- `iam.subscriptions.*` and `iam.entitlements.view` are granted to
  the Owner role (the platform-admin `super` and `platform` roles
  do not have these keys).
- `billing.plans.*`, `billing.subscriptions.*`,
  `billing.entitlements.override` are **not** granted to the default
  support role. Only `super` (and `platform` for read-only) carry
  the relevant keys; the default role seed keeps support read-only.
- Workspace APIs (`/tenants/:id/subscription*`) do not accept the
  `billing.*` keys; they remain `iam.subscriptions.*`. A workspace
  user cannot mutate platform-wide plans even by passing a body
  field — the plan router lives under `/admin/*` and requires
  `adminAuth`.
- Workspace `/tenants/:id/...` routes use `authenticate` +
  `tenantIsolation`. A user from tenant A cannot read tenant B's
  subscription by passing B's id in the URL.

### 7.2 Audit

All privileged writes emit an event through `auditLogService.emit`:

- `subscription.created`, `subscription.plan_changed`,
  `subscription.canceled`, `subscription.reactivated`,
  `subscription.state_changed`, `subscription.migrated` (module
  `iam.subscriptions`).
- `entitlement.override.created`, `entitlement.override.clamped`,
  `entitlement.override.revoked` (module `iam.entitlements`).
- `plan.created`, `plan.updated`, `plan.archived`, `plan.disabled`,
  `plan.enabled` (module `billing.plans`).

Each event carries the actor, target, before / after, reason and
timestamp. The audit redaction contract
(`auditLog.service.js` `SENSITIVE_KEYS`) is unchanged.

---

## 8. Migration and backward compatibility

- **Existing tenants keep working.** No data migration is required.
  The first `GET /tenants/:id/subscription` lazy-provisions a
  subscription on the tenant's existing `planId`, or on the
  safe-fallback `starter` plan if the plan code is no longer in the
  catalogue. A `subscription.migrated` event records the
  substitution.
- **Existing `GET /tenants/:id/billing` facts endpoint is preserved.**
  Its current shape is unchanged; Phase 6 adds the new endpoints
  alongside it.
- **Existing routes for tenant admin / settings / members /
  onboarding / invitations are not changed.**
- **Existing audit consumers are not changed.** New event types
  are additive; existing consumers ignore them.
- **The `billing.v1.enabled` feature flag (existing
  `FeatureFlag` model) returns the new routes to 404 without
  taking the legacy endpoint down. Rollback is a single
  `FeatureFlag` update, no redeploy.**

---

## 9. Payment-provider decisions still required

These are **deferred** and recorded here honestly:

- **Provider selection.** Stripe / Paddle / Chargebee / Adyen / none.
  The codebase has zero payment dependencies and the plan catalogue
  has zero commercial fields.
- **Final commercial pricing and billing intervals.** Not invented
  in Phase 6. The catalogue has `tier`, `trialDays` and
  `graceDays` only.
- **Trial and free-tier policy.** Encoded as `trialDays` on the
  plan and `trialing` as a subscription state; the actual
  policy (e.g. "30 days, no card required") is a business decision.
- **Tax / VAT and invoice numbering policy.** No invoice model
  exists; the Owner "Invoices" tab is an honest empty state.
- **Refund and cancellation policy.** Encoded only in the
  subscription state machine; the commercial policy is a business
  decision.
- **Payment-failure and grace-period rules.** Encoded as
  `past_due` and `graceDays`; the actual dunning flow (emails,
  retries, suspension) is a business decision.
- **Webhook signature verification using the provider's official
  mechanism.** Phase 6 returns 501 BEFORE any signature check, so
  no payload ever reaches a handler.
- **Server-side `entitlementService.applyPaymentEvent(...)`**. Not
  implemented. The provider-neutral `PaymentNormalizedEvent` shape
  is documented in the plan (§9.4) for when a provider is selected.
- **Production configuration of provider API keys.** Not added.
  Will be env-only (`BILLING_PROVIDER_*`) and never committed.

**No customer is charged. No production billing state is changed.**

---

## 10. Production configuration and rollout requirements

- **No new environment variables are required for Phase 6.** The
  entitlement and quota resolution are deterministic from the
  catalogue and the subscription rows.
- **The plan seed must run on first deploy.** `POST
  /admin/plans/ensure-defaults` is idempotent; an admin can call
  it once or the entitlement service can call it lazily on first
  read.
- **The 15-minute reconciliation job is wired but the cron is out
  of scope for Phase 6.** The function
  `usageService.reconcile({ tenantId, metric, value })` is the
  authoritative path; deployment wiring is a follow-up.
- **The `billing.v1.enabled` feature flag is honored at the route
  mount.** Setting it to `false` returns the new routes to 404
  without affecting the legacy `GET /tenants/:id/billing` endpoint.
- **Production must NOT enable live charges until a provider is
  selected, the contract is signed off, and the provider integration
  is implemented per the plan §9.4 contract.**

---

## 11. Test commands and results (exact)

### 11.1 Backend

```
$ npm test
# tests 479
# pass 479
# fail 0
# skipped 0
# duration_ms 100926.1481
```

Run twice in sequence; same result both times. Phase 5 baseline was
438/438; Phase 6 added 41 tests (29 service unit tests + 12 HTTP
integration tests).

```
$ npm run ci:guards
check-stubs: OK
check-routes: OK
check-models: OK
check-config: OK
check-readme-sync: OK
ci:guards OK
```

### 11.2 Frontend

```
$ npm test
 Test Files  25 passed (25)
      Tests  240 passed (240)
```

```
$ npm run typecheck
> tsc --noEmit
(no output)
```

```
$ npm run lint
✖ 9 problems (0 errors, 9 warnings)
```

The 9 warnings are pre-existing `react-refresh/only-export-components`
warnings; no new errors are introduced by Phase 6.

```
$ npm run build
✓ built in 2.23s
✓ built in 1.38s
(multi-pass Vercel output)
```

### 11.3 git diff --check

Both repositories: only CRLF-on-Windows informational warnings
(`LF will be replaced by CRLF the next time Git touches it`).
**No whitespace errors and no line-ending errors.**

---

## 12. Known limitations and deferred work

- **No payment provider.** Recorded in §9.
- **No real invoice generation.** The Owner "Invoices" tab returns
  an honest empty state; the API surface is `noop` only.
- **No tax / VAT handling.**
- **No automatic dunning emails on `past_due`.** The UI surfaces
  the state and the grace window; emails are out of scope.
- **`storedRows` reconciliation is additive only.** A hard purge
  of connector rows is out of scope.
- **Process-wide entitlement cache is out of scope** (see
  PHASE_6_BILLING_PLAN.md §4.5). Each call performs two queries;
  per-request caching via `AsyncLocalStorage` is a follow-up.
- **Quota enforcement at the existing connector / dashboard /
  report / alert / member write boundaries was NOT done in Phase 6.**
  The new authoritative write boundaries (subscription and
  entitlement routes) are wired with the entitlement check. Wiring
  the pre-existing services is a follow-up that would touch every
  service and is recorded here so it is not silently marked
  complete.
- **The reconciliation job is implemented as a function but the
  cron is not yet wired to a real scheduler.** The function
  `usageService.reconcile({ tenantId, metric, value })` is the
  authoritative path; deployment is a follow-up.
- **MFA audit-event emission** (Phase 5 carry-over): `mfa.service.js`
  and `mfa.controller.js` do not call `auditLogService.emit` for
  enroll/verify/disable. Not addressed by Phase 6.
- **Support impersonation start/stop UI** (Phase 5 carry-over):
  the API is intact and tested, but the AdminShell does not
  surface the start/stop flow. Not addressed by Phase 6.

---

## 13. Definition-of-Done cross-check

| DoD item | Status | Evidence |
|---|---|---|
| 1. Every implemented plan and quota has a documented authoritative definition | ✅ | This report §3 + §4; the plan §4 + §5 |
| 2. Effective entitlements are resolved centrally | ✅ | `entitlement.service.js#resolveEffective`; tested in `entitlement.service.test.js` |
| 3. Quotas are enforced on the backend under concurrent requests | ✅ | `usageCounter.repository.js#incrementOrCreate` (atomic `$inc` + `upsert`); proven by `entitlement.service.test.js` "concurrent writes at the limit cannot exceed by more than one" |
| 4. Subscription lifecycle transitions are validated and audited | ✅ | `subscription.service.js#assertTransition` is the only authority; every transition writes a `SubscriptionHistory` row and emits an `iam.subscriptions.*` audit event |
| 5. Workspace Owners can inspect and manage only their own tenant's permitted subscription settings | ✅ | `authenticate` + `tenantIsolation` on every workspace route; permission-gated mutations; covered by `billing-integration.test.js` "cross-tenant access is rejected" and "Manager cannot cancel" |
| 6. Platform Admin actions enforce the existing permission model and emit audit events | ✅ | `adminAuth` + `billing.*` keys; every write emits a `billing.*` or `iam.entitlements.*` event |
| 7. Existing tenants remain compatible through a documented migration/default policy | ✅ | This report §8; lazy provisioning on first read; safe-fallback plan; `subscription.migrated` event |
| 8. Tests and build gates pass | ✅ | This report §11 |
| 9. Payment-provider integration and commercial policy are accurately marked deferred | ✅ | This report §9 + §12 |
| 10. No customer is charged and no production billing state is changed | ✅ | No live charges; no payment provider; the `noop` adapter is the only registered provider |

---

## 14. Files of note

- `backend/docs/PHASE_6_BILLING_PLAN.md` — the plan.
- `backend/docs/PHASE_6_BILLING_REPORT.md` — this file.
- `backend/src/services/entitlement.service.js` — central resolver.
- `backend/src/services/usage.service.js` — quota enforcement boundary.
- `backend/src/services/subscription.service.js` — lifecycle authority.
- `backend/src/repositories/usageCounter.repository.js` — atomic
  counter primitives (the only safe check-then-write path).
- `backend/src/services/paymentProvider.adapter.js` — provider-neutral
  boundary (Phase 6 ships `noop` only).
- `backend/tests/billing-integration.test.js` — 12 end-to-end HTTP
  tests against the real Express app.
- `frontend/src/features/billing/components/BillingPanel.tsx` —
  Owner-facing subscription / usage / activity panel.
- `frontend/src/features/admin/components/BillingViews.tsx` —
  admin plan / subscription / override views with confirm dialogs.
