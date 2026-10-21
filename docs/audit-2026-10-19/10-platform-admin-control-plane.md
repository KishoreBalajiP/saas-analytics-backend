# 10. Platform administration control plane

**Audience:** the platform operations and security owners of Analivo, and the engineers building the admin portal.

**Summary.** The control plane has a real core: a separate admin JWT audience with live session checks, TOTP MFA, default-deny permissions, an audited admin lifecycle with last-super-admin protection on suspend and demote, tenant lifecycle transitions that revoke tenant sessions, access-request approval, and a support toolkit whose impersonation requires a reason, is capped per day and is double-logged. Most of this has HTTP tests. The plane is weak at its edges, and four of those edges are serious:

1. `GET /admin/admins` returns every admin's password hash and encrypted MFA secret to anyone with `iam.admins.view` ({{ADM:pwhash}}). I confirmed the list path returns raw lean documents (`backend/src/repositories/admin.repository.js:87-101`, `backend/src/controllers/admin.controller.js:45-56`); existing tests only check single-admin responses.
2. Any admin with `iam.admins.assign` can grant themselves the super role, and any admin can change their own `adminType` and `tenantScope` ({{ADM:self-escalate}}, {{ADM:self-patch}}).
3. Any holder of an admin access token can silently switch MFA off by re-enrolling, and there is no recovery path for a lost authenticator ({{AUTH:mfa-reenroll}}, {{AUTH:no-recovery-codes}}).
4. Impersonation mints a full user session whose impersonation flag nothing enforces ({{ADM:impersonation}}).

Platform configuration (settings, feature flags, email templates) is not manageable over HTTP: those routes return 501 ({{ADM:config-501}}).

## 10.1 Administrative authentication

| Control | Status | Evidence / gap |
|---|---|---|
| Dedicated admin login, separate audience | **Implemented and verified** | `/admin-auth/*`, `JWT_AUDIENCES` (`backend/src/utils/jwt.js:35-40`), `tests/admin-auth-mfa.integration.test.js` |
| Password + lockout + login-attempt trail | **Implemented and verified**, with defects | Lockout re-arms after one failure once the window passes ({{AUTH:lockout-rearm}}); the strict limiter is shared with every public auth route |
| TOTP MFA enrolment and verification | **Implemented and verified** | Secret encrypted at rest; codes replayable inside the ±30 s window |
| MFA enforcement policy | **Missing** | MFA is optional per admin; no platform rule requires it for privileged roles |
| MFA disable / reset / recovery codes | **Broken / Missing** | Re-enrol disables MFA without step-up; the disable handler is not routed; no recovery codes; no admin-assisted reset ({{AUTH:mfa-reenroll}}, {{AUTH:no-recovery-codes}}) |
| Session expiry and revocation | **Implemented and verified** | 15 min access tokens bound to DB sessions; refresh rotation with family revocation; suspend revokes sessions; sessions slide indefinitely (no absolute lifetime) |
| Password recovery | **Broken end to end** | API works, but the emailed link points to `/reset-password`, which the frontend does not have, and the admin login page has no "forgot password" link ({{AUTH:admin-reset-link}}) |
| Invitation acceptance | **Missing** | Admins are created with a password by another admin; `pending` admins can log in ({{ADM:invite-flow}}, {{AUTH:pending-admin}}) |
| Permission resolution after login | **Implemented and verified**, with a divergence | `/admin-auth/me` returns roles and permissions (commit `6dbd3f9`), but resolves them at platform scope while enforcement resolves at the admin's `tenantScope` ({{ADM:me-scope}}) |
| Step-up for sensitive actions | **Missing** | No re-authentication before role grants, MFA changes, impersonation or tenant deletion |

## 10.2 Administrator lifecycle

| Operation | Status | Notes |
|---|---|---|
| List / create / view / update | Implemented and verified | List leaks secrets ({{ADM:pwhash}}); update lets admins change their own type and scope ({{ADM:self-patch}}) |
| Suspend / restore | Implemented and verified | Last-active-super guard (`backend/src/services/admin.service.js:318-347`) |
| Assign / revoke role | Implemented, broken edges | No self-target or ceiling check ({{ADM:self-escalate}}); tenant-scoped grants cannot be revoked through the API ({{ADM:revoke-scoped}}); role existence and tenant existence not validated |
| Remove / archive | **Missing** | Suspension is the only removal |
| Pending invitations, resend, revoke | **Missing** | |
| Explicit session revocation | **Missing** as an endpoint | Implicit through suspend and password reset |
| Activity view | Implemented but incompletely verified | `GET /admin/admins/:id/audit` |

Required protections: no self-modification of privilege; role ceiling; last-super protection extended to role revocation and removal; two-person approval for granting super; step-up for all of these; every change audited with before/after.

## 10.3 Platform dashboard

`GET /admin/dashboard/summary` returns tenant counts by status, recent tenants, "recent platform admin actions" and a health block. The recent-actions list never shows the actor and is not limited to admin actions, and the health values for queue, scheduler, storage and connectors are placeholders ({{ADM:dashboard-metrics}}). The frontend gates the dashboard on `monitoring.view` while the route requires `iam.tenants.view`.

| Metric requested by the brief | Available today | Source to build it from |
|---|---|---|
| Total / active / suspended tenants | Yes | `Tenant.status` |
| Registered users, new registrations | No | `User.createdAt` grouped by day |
| Active users | No | `Session.lastUsedAt` within window |
| Failed onboarding | No | Tenants in `pending` older than the verification TTL; unverified users |
| Active data connections, failed refresh jobs | No | `Connector.status`, `SyncRun` (document 06) |
| Query volume and failures | No | `AnalyticsQuery` plus error counters |
| AI requests and errors | No (no AI yet) | `AiInvocation` (document 08) |
| API usage | No | Per-key counters (document 09) |
| Subscription and entitlement status | Partially (admin billing pages) | `Subscription` |
| Recent security events | No | Security event stream (document 11) |
| Open incidents | No | Incident records (document 12) |

Each metric needs a stated source, calculation, time window and refresh interval shown on the card, and placeholder values must be removed rather than displayed.

## 10.4 Tenant management

| Capability | Status | Notes |
|---|---|---|
| Search and filter | Implemented and verified | Status, name/slug search, pagination |
| Lifecycle (pending, active, suspended, disabled, archived) | Implemented and verified | Legal transition graph; audited; revokes tenant **sessions** |
| Cascade to API keys, embed tokens, scheduled reports, alerts, queued jobs, webhooks | **Missing** | A suspended tenant's keys, embeds, schedules and webhooks keep working ({{ADM:suspend-cascade}}) |
| Plan, usage and billing view | Partially implemented | `GET /tenants/:id/billing` returns a hard-coded `hasHistory: false` |
| Secret tenant settings | **Defect** | `iam.tenants.view` alone can request `includeSecrets=true` and receive secret settings in plaintext ({{ADM:secrets}}) |
| Deletion, export, retention | **Missing** | `archived` is terminal; no purge or export ({{TEN:no-delete}}) |
| Raw customer data access | **Not exposed by tenant views** | Admins see tenant metadata; row-level data is reachable only through impersonation (10.7) |

## 10.5 Access requests and onboarding operations

Access requests can be submitted anonymously (deduplicated only on exact field match), listed, approved and rejected; approval creates an invitation into an **existing active** tenant, gated by `adminType` rather than a permission key and with a free-text role name ({{TEN:access-approval}}). There is no tooling to see stuck verifications, pending tenants, failed invitation emails, or to resend safely ({{ADM:onboarding-tools}}). Recommended operations, each as an audited backend action rather than a database edit: resend verification; expire and reissue an invitation; list tenants stuck in `pending` with the reason; mark an email bounced; merge or close a duplicate workspace with the owner's confirmation.

## 10.6 Platform configuration

| Area | Status |
|---|---|
| Settings (`/settings/*`) | 501 for all six endpoints, while the `Setting` model and service work internally |
| Feature flags (`/feature-flags/*`) | 501; flags are seeded and evaluated internally but cannot be managed |
| Email templates (`/email-templates/*`) | 501 |
| Plans and entitlements | Implemented (admin plan/subscription/entitlement routes) but permission keys are not seeded (document 13) |
| Master data | Implemented; writes require only `adminAuth`, no permission ({{ADM:masterdata}}) |
| Connector availability, AI provider availability, global rate limits, maintenance notices | Missing (only a per-tenant `general.maintenance_notice` setting key exists, with no consumer) |
| Change history and rollback | Missing |

Safeguards to build with these surfaces: schema validation per key; permission per area; audit with before/after; version history with one-click rollback; staged rollout for flags (percentage and tenant lists already exist in `FeatureFlag`); and two-person approval for security-relevant settings.

## 10.7 Support access

| Capability | Status | Notes |
|---|---|---|
| Impersonation with reason, daily cap, TTL, double audit | Implemented and verified | The cap is computed from a buffered access log and can be bypassed by rapid calls ({{ADM:cap-bypass}}) |
| What impersonation grants | **Too much** | A real user session (audience `user`) with the user's full permissions, including writes and raw data; the `impersonation` claim is not enforced anywhere; tenant status is ignored ({{ADM:impersonation}}) |
| Attribution | **Defect** | Actions during impersonation are attributed to the impersonated user ({{GOV:impersonation-attribution}}) |
| Tenant notification and consent | Missing | |
| Recover account, revoke sessions, lookups, broadcast | Implemented and verified | Lookups write an audit row without a reason |
| Frontend support page | **Broken** | Gated on a permission the admin roles do not hold, and request payloads do not match backend validators ({{ADM:support-ui}}) |
| Scoped support admins | **Not confined** | `tenantScope` is not applied to `/tenants/:id/*` or `/audit-logs` ({{TEN:support-scope}}, {{GOV:auditlog-scope}}) |

**Target model.** Default to **sanitised diagnostics** that need no customer-data access: tenant configuration metadata, connector and job status with error summaries, recent audit events, usage counters and request traces by request id. Make impersonation the exception: request with justification and ticket reference; approval by the tenant owner (or by a super admin for an incident, recorded as break-glass); time-boxed (15 minutes default, renewable); **read-only by default**, with write mode as a separate approval; a visible banner in the tenant UI; every request attributed to the operator with `onBehalfOf`; automatic expiry and a notification to the tenant afterwards. Silent impersonation and unrestricted cross-tenant access should not exist.

## Findings in this area

{{ADM:pwhash}}, {{ADM:self-escalate}}, {{ADM:self-patch}}, {{ADM:impersonation}}, {{ADM:suspend-cascade}}, {{ADM:support-ui}}, {{ADM:revoke-scoped}}, {{ADM:me-scope}}, {{ADM:invite-flow}}, {{ADM:dashboard-metrics}}, {{ADM:cap-bypass}}, {{ADM:config-501}}, {{ADM:masterdata}}, {{ADM:secrets}}, {{ADM:onboarding-tools}}, {{AUTH:mfa-reenroll}}, {{AUTH:no-recovery-codes}}, {{AUTH:admin-reset-link}}, {{AUTH:pending-admin}}, {{AUTH:lockout-rearm}}, {{TEN:support-scope}}, {{TEN:access-approval}}, {{TEN:no-delete}}, {{GOV:auditlog-scope}}, {{GOV:impersonation-attribution}}. Full details are in `19-findings-register.md`.
