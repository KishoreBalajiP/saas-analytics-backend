# Phase 7 — Product Functionality & Subscription Enforcement

## Audit: Subscription-Controlled Operations Gap Matrix

**Scope:** All backend operations that create, update, or consume billable resources, and their frontend counterparts. The entitlement and usage services from Phase 6 are the canonical enforcement points; the audit identifies where those services are called, where they are missing, and where enforcement gaps exist.

---

### 1. Connectors and datasets

| Operation | API Route | Service/Repo | Entitlement Check? | Quota Metric | Limitation | Concurrency Guard? | Frontend Enforcement |
|-----------|-----------|--------------|--------------------|--------------|------------|--------------------|----------------------|
| Create connector | `POST /tenants/:id/connectors` | `connectorService.create` → repo `upsert` | **Missing** — no `entitlementService.can()` or `usageService.checkAndConsume()` call before resource creation. | `connectors` limit from plan | Hard limit per plan; no atomic pre-check. | `ConnectorList` shows disabled state when limit reached, but creation button can be clicked without backend guard. |
| Update connector | `PATCH /tenants/:id/connectors/:id` | `connectorService.update` → repo `update` | **Missing** — same as create. | `connectors` limit | Same as create. | Same as create. |
| Delete connector | `DELETE /tenants/:id/connectors/:id` | `connectorService.delete` → repo `findOneAndDelete` | **Missing** — no usage decrement or quota check. | `connectors` limit | No decrement on delete; counter may diverge from actual count. | UI allows deletion; no backend guard. |
| Sync job (trigger) | `POST /tenants/:id/connectors/:id/run-sync` | `syncJobService.trigger` | **Missing** — no per-connector quota check; job may run unbounded. | N/A (job-scoped) | No guard against runaway jobs. | "Run sync" button always enabled; no disabled state when at limit. |
| List connectors | `GET /tenants/:id/connectors` | `connectorService.list` | **N/A** (read) | N/A | N/A | Always enabled. |

**Gap summary:** Connectors create/update/delete do not call `entitlementService.checkLimit()` or `usageService.checkAndConsume()` before modifying the resource. The `connectors` metric limit exists in plan defaults but is never enforced at the point of resource mutation.

---

### 2. Datasets (imported data)

| Operation | API Route | Service/Repo | Entitlement Check? | Quota Metric | Limitation | Concurrency Guard? | Frontend Enforcement |
|-----------|-----------|--------------|--------------------|--------------|------------|--------------------|----------------------|
| Create dataset/import | `POST /tenants/:id/datasets` | `datasetService.import` → repo | **Missing** — no entitlement check before import. | `dashboards` / `storedRows` | Import may consume storedRows depending on data size; no accounting. | `DatasetCreate` shows limit in empty state but no hard guard. |
| Update dataset | `PATCH /tenants/:id/datasets/:id` | `datasetService.update` | **Missing** | `dashboards` | Same as create. | Same as create. |
| Delete dataset | `DELETE /tenants/:id/datasets/:id` | `datasetService.delete` → repo | **Missing** — no usage decrement. | `storedRows` | Counter may diverge. | UI allows deletion without guard. |

**Gap summary:** Dataset import creates data records but does not increment `storedRows` or check the plan's `storedRows` limit. No atomic pre-check exists.

---

### 3. Dashboards

| Operation | API Route | Service/Repo | Entitlement Check? | Quota Metric | Limitation | Concurrency Guard? | Frontend Enforcement |
|-----------|-----------|--------------|--------------------|--------------|------------|--------------------|----------------------|
| Create dashboard | `POST /tenants/:id/dashboards` | `dashboardService.create` → repo | **Missing** — no `checkAndConsume` before creation. | `dashboards` limit | Hard limit per plan; creation can exceed limit. | `DashboardEditor` "Save" button always enabled. |
| Update dashboard | `PATCH /tenants/:id/dashboards/:id` | `dashboardService.update` | **Missing** — update counts as new dashboard in some code paths. | `dashboards` | Same as create. | Same as create. |
| Delete dashboard | `DELETE /tenants/:id/dashboards/:id` | `dashboardService.delete` → repo | **Missing** — no usage decrement. | `dashboards` | Counter may diverge. | UI allows deletion. |
| List dashboards | `GET /tenants/:id/dashboards` | `dashboardService.list` | **N/A** (read) | N/A | N/A | Always enabled. |

**Gap summary:** Dashboard creation does not call `usageService.checkAndConsume({tenantId, metric: 'dashboards', requested: 1})` before persisting. No atomic pre-check. Updates may silently increment the counter.

---

### 4. Reports and exports

| Operation | API Route | Service/Repo | Entitlement Check? | Quota Metric | Limitation | Concurrency Guard? | Frontend Enforcement |
|-----------|-----------|--------------|--------------------|--------------|------------|--------------------|----------------------|
| Create report | `POST /tenants/:id/reports` | `reportService.create` | **Missing** — no dashboard/report limit check. | `reports` limit | Hard limit; creation can exceed. | "Create report" button always enabled. |
| Generate export (audit-log) | `POST /admin/exports` (audit) | `exportService.generate` | **Missing** — no entitlement check; admin override used but not tied to plan limits. | `storedRows` / `reports` | Admin override may bypass plan limits. | Admin UI shows button; no disabled state when at limit. |
| List reports | `GET /tenants/:id/reports` | `reportService.list` | **N/A** (read) | N/A | N/A | Always enabled. |

**Gap summary:** Report creation does not check `reports` limit via `usageService.checkAndConsume`. Export operations may bypass plan limits entirely via admin override without guard.

---

### 5. Alerts and scheduled reports

| Operation | API Route | Service/Repo | Entitlement Check? | Quota Metric | Limitation | Concurrency Guard? | Frontend Enforcement |
|-----------|-----------|--------------|--------------------|--------------|------------|--------------------|----------------------|
| Create alert | `POST /tenants/:id/alerts` | `alertService.create` | **Missing** — no `checkAndConsume` before creation. | `alerts` limit | Hard limit; creation can exceed. | "Add alert" button always enabled. |
| Update alert | `PATCH /tenants/:id/alerts/:id` | `alertService.update` | **Missing** | `alerts` | Same as create. | Same as create. |
| Delete alert | `DELETE /tenants/:id/alerts/:id` | `alertService.delete` → repo | **Missing** — no usage decrement. | `alerts` | Counter may diverge. | UI allows deletion. |
| Create scheduled report | `POST /tenants/:id/scheduled-reports` | `scheduledReportService.create` | **Missing** — no `alerts`/`scheduledReports` check. | `scheduledReports` limit | Hard limit; creation can exceed. | "Schedule report" always enabled. |

**Gap summary:** No entitlement check before creating alerts or scheduled reports. Usage counters may diverge from actual counts.

---

### 6. Workspace members and invitations

| Operation | API Route | Service/Repo | Entitlement Check? | Quota Metric | Limitation | Concurrency Guard? | Frontend Enforcement |
|-----------|-----------|--------------|--------------------|--------------|------------|--------------------|----------------------|
| Invite member | `POST /tenants/:id/invitations` | `invitationService.create` | **Missing** — no `members` limit check before invitation creation. | `members` limit | Hard limit; invitation may exceed limit. | "Invite member" button always enabled. |
| Accept invitation | `POST /tenants/:id/invitations/:id/accept` | `invitationService.accept` | **Partial** — acceptance may add member, but no pre-check. | `members` | Same as create. | Same as create. |
| Revoke invitation | `DELETE /tenants/:id/invitations/:id` | `invitationService.revoke` | **Missing** — no `members` decrement on revoke. | `members` | Counter may diverge. | UI allows revocation. |
| Add member directly | `POST /tenants/:id/members` | `memberService.create` | **Missing** — no `members` limit check. | `members` | Same as create. | Same as create. |
| Remove member | `DELETE /tenants/:id/members/:id` | `memberService.delete` → repo | **Missing** — no `members` decrement. | `members` | Counter may diverge. | UI allows removal. |

**Gap summary:** No `members` limit check before inviting or adding members. No decrement on revocation/removal. Counters may diverge from actual member count.

---

### 7. API keys and API usage

| Operation | API Route | Service/Repo | Entitlement Check? | Quota Metric | Limitation | Concurrency Guard? | Frontend Enforcement |
|-----------|-----------|--------------|--------------------|--------------|------------|--------------------|----------------------|
| Create API key | `POST /tenants/:id/api-keys` | `apiKeyService.create` | **Missing** — no `apiCallsPerDay` or `storedRows` check. | `apiCallsPerDay` limit | Hard limit; key creation can exceed. | "Create API key" button always enabled. |
| Revoke API key | `DELETE /tenants/:id/api-keys/:id` | `apiKeyService.delete` → repo | **Missing** — no `apiCallsPerDay` decrement. | `apiCallsPerDay` | Counter may diverge. | UI allows revocation. |
| Record API call | `POST /tenants/:id/api-usage` (internal) | `usageService.incrementCumulative` | **Partial** — incremental but no pre-check against limit. | `apiCallsPerDay` | Increment happens; limit check happens separately in `checkAndConsume`. | Frontend may send usage without quota guard. |

**Gap summary:** API key creation does not check `apiCallsPerDay` limit. The `incrementCumulative` path records usage but does not prevent creation beyond the limit.

---

### 8. Embedded analytics

| Operation | API Route | Service/Repo | Entitlement Check? | Quota Metric | Limitation | Concurrency Guard? | Frontend Enforcement |
|-----------|-----------|--------------|--------------------|--------------|------------|--------------------|----------------------|
| Render embedded iframe | Frontend only (no backend API) | N/A | **N/A** — feature flag `embed` from entitlements. | `embed` feature flag | Feature is gated by `entitlementService.can(tenantId, 'embed')`. | Frontend reads entitlements and hides/shows embed widget. | `BillingPanel` and admin views already read `embed` feature; but other pages may not. |

**Gap summary:** The `embed` feature flag is resolved by entitlement service, but some frontend pages may not check it before showing the embed widget.

---

### 9. Storage and data retention

| Operation | API Route | Service/Repo | Entitlement Check? | Quota Metric | Limitation | Concurrency Guard? | Frontend Enforcement |
|-----------|-----------|--------------|--------------------|--------------|------------|--------------------|----------------------|
| Upload stored rows data | `POST /tenants/:id/data` (various) | `dataService.upload` | **Missing** — no `storedRows` check before write. | `storedRows` limit | Hard limit; upload can exceed. | Upload button always enabled. |
| Delete stored rows | `DELETE /tenants/:id/data` | `dataService.delete` → repo | **Missing** — no `storedRows` decrement. | `storedRows` | Counter may diverge. | UI allows deletion. |

**Gap summary:** No `storedRows` limit check before data uploads. No decrement on deletes.

---

### 10. Background jobs and synchronization

| Operation | API Route | Service/Repo | Entitlement Check? | Quota Metric | Limitation | Concurrency Guard? | Frontend Enforcement |
|-----------|-----------|--------------|--------------------|--------------|------------|--------------------|----------------------|
| Run usage reconciliation job | `POST /admin/subscriptions/reconcile` (operator) | `billingReconcile.service` + job | **Partial** — admin override; not tied to per-tenant plan limits. | N/A (global) | Safety-net clamps exist but may not reflect per-tenant plan changes. | Admin override required; no frontend protection. |
| Run billing webhook reconciliation | N/A (Razorpay→webhook→lifecycle) | `billingLifecycle.service` | **N/A** (event-driven) | N/A | Events flow through lifecycle; no additional quota guard needed if lifecycle is authoritative. | N/A |

**Gap summary:** Reconciliation job uses admin override but does not re-read per-tenant plan limits before setting usage counters; could silently set values above plan limits.

---

## Summary of Gaps

| Resource | Metric | Gap | Severity |
|----------|--------|-----|----------|
| Connectors | `connectors` | No pre-create/update/delete entitlement check | **High** — limit can be exceeded silently |
| Datasets | `storedRows` | No import accounting | **High** — counter diverges |
| Dashboards | `dashboards` | No pre-create/update entitlement check | **High** — limit can be exceeded |
| Reports | `reports` | No pre-create entitlement check | **High** — limit can be exceeded |
| Alerts | `alerts` | No pre-create entitlement check | **High** — limit can be exceeded |
| Scheduled reports | `scheduledReports` | No pre-create entitlement check | **High** — limit can be exceeded |
| Members | `members` | No pre-invite/add/check on remove | **High** — limit can be exceeded, counters diverge |
| API keys | `apiCallsPerDay` | No pre-create check; incremental usage only | **Medium** — usage may exceed limit |
| Embed feature | `embed` feature flag | Some pages may not check before showing widget | **Low** — feature flag already gated |
| Stored rows | `storedRows` | No pre-upload/decrement check | **High** — counter diverges |
| Reconciliation | N/A | May set counters above plan limits | **Medium** — admin override safety net exists |

---

## Next Steps — Implementation

The audit identifies concrete gaps where the canonical entitlement (`entitlementService`) and usage (`usageService`) services are not called at the point of resource mutation. The implementation plan (Phases 7.2–7.6) will:

1. **Centralize entitlement enforcement** — make `entitlementService` the single authority (7.2).
2. **Strengthen atomic quota enforcement** — ensure `usageService.checkAndConsume()` is called before every resource write that consumes a quota (7.3).
3. **Wire enforcement into existing services** — connectors, datasets, dashboards, reports/exports, alerts/scheduled reports, members/invitations, API keys (7.4).
4. **Integrate billing/subscription state** — verify Phase 6.1 flow is correct (7.5).
5. **Update frontend experience** — reflect backend entitlements in UI (7.6).
6. **Add tests and regression protection** (7.8).
7. **Final validation and report** (10).

Proceed directly into Phase 7.2 — Centralized entitlement enforcement.