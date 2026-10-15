# Backend API Inventory and Contract Gaps

Audit date: 2026-10-15. The backend has 36 route modules under `src/routes`; route registration is composed by `src/routes/index.js` and mounted by `src/app.js` under the configured API prefix. The route guard passed, confirming registered route declarations are generally protected or explicitly annotated, but the guard is not a substitute for object-level authorization testing.

## Surface inventory

| Surface | Representative routes/modules | Auth boundary | Tenant/authority notes |
|---|---|---|---|
| Health | health routes | Public health exemptions where documented | Must not expose secrets; readiness semantics require staging verification |
| Tenant auth | `auth.routes.js`, `admin-auth.routes.js` | User/admin authentication | Session and portal separation |
| IAM/admin | users, roles, permissions, admins, tenants | `adminAuth` plus permission middleware | Platform-admin authority; verify object IDs and role mutation boundaries |
| Tenant workspace | tenants, invitations, settings, feature flags | User auth, tenant resolution, permissions | JWT-backed tenant context is authoritative |
| Connectors/webhooks | connector and webhook routes | Connector routes authenticated; inbound webhooks HMAC-verified | Verify config encryption, SSRF, row ownership, and idempotency |
| Analytics/master data | analytics and master-data routes | Tenant auth/permissions; master-data writes admin-gated | Aggregation must retain tenant and soft-delete filters |
| Dashboards/widgets | dashboard routes | Auth, tenant resolution, dashboard/analytics permissions | Verify dashboard, widget, dataset, and share ownership |
| Reports/alerts/notifications | report, alert, notification routes | Auth, tenant resolution, permissions | Verify export bounds and background tenant context |
| Governance/operations | audit-log, access-log, compliance, monitoring, support | Admin auth and permissions; public subject request path is explicit | Verify audit redaction and support-access auditing |
| Billing | subscription, billing webhook, plan/entitlement routes | Workspace/admin permissions; signed provider webhook | Verify raw-body signature handling and replay/idempotency |
| External API | external routes and API-key routes | API-key auth with declared scopes; management uses user auth | Verify scope-to-resource and tenant mapping |
| Embed | embed token management and public execution | Management uses user auth; public execution uses token/rate limits | Verify published-resource and token tenant binding |

## Contract gaps requiring follow-up

- No single authoritative OpenAPI document was identified in the backend inventory.
- Route declarations, validators, controllers, frontend API contracts, and sprint reports are distributed; they should be reconciled into the contract inventory before any API change.
- Status/error semantics must be sampled per surface, especially 401 vs 403 vs 404 behavior for cross-tenant identifiers.
- Pagination, filtering, request-size, timeout, export, and query-resource limits need a route/resource matrix rather than inference from representative files.
- API-key scopes and embed-token claims require negative tests for wrong tenant, unpublished resource, expired token, revoked key, and insufficient scope.

## Contract-preservation rule

No route rename, response-shape change, permission rename, environment-variable rename, or schema change should be made without identifying the existing caller/tests and documenting backward compatibility and rollout requirements.

