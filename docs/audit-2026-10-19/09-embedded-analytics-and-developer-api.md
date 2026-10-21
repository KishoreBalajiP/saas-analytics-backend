# 09. Embedded analytics, API keys and developer experience

**Audience:** engineers and product owners responsible for the developer and embedding surface, which is a separate product with its own security model.

**Verdict:** the developer API and embedded analytics are **not functional end to end**, and no backend test exercises them over HTTP. Earlier reports described both as implemented; that is not supported by the code.

- **API key management is broken.** The `/api-keys` routes never run tenant resolution, but the controllers read `req.tenant` (`backend/src/routes/api-key.routes.js`, `backend/src/controllers/apiKey.controller.js:15,31,44,57,74`). Key creation therefore fails with 400 "tenantId is required" (`backend/src/services/usage.service.js:41`), listing returns nothing, and the by-id routes run without a tenant filter (`backend/src/repositories/apiKey.repository.js:43-44`) ({{API:no-tenant}}, {{API:idor}}).
- **Embedding is broken.** The same missing tenant resolution affects `/embed/tokens`. Independently, `dashboardService.getDashboard()` returns `{ dashboard }` (`backend/src/services/dashboard.service.js:330-341`), but the embed service checks `dashboard.status` on that wrapper (`backend/src/services/embed.service.js:49-51,162-165`), so minting always fails with "Only published dashboards can be embedded" and the public read always fails. The external `GET /external/dashboards/:id` has the same defect (`backend/src/services/externalApi.service.js:127-133`) ({{API:wrapper}}).
- **The external dataset API is correct in isolation** (scope check, tenant from key, dataset ownership verified, engine tenant filter) but unreachable, because no key can be created through the product.

Because the surface is not in use, this is the right moment to fix the defects **and** adopt a safer embedding model before customers depend on the current contract.

## 1. Capability status

| Capability | Status | Evidence |
|---|---|---|
| Key format and storage | **Implemented but incompletely verified** | `sak_` prefix lookup + SHA-256 secret hash, constant-time compare (`backend/src/services/apiKey.service.js:154-185`); secret returned once |
| Key create / list / get / update / revoke | **Broken** | No tenant context (above) |
| Key rotation | **Partially implemented** | Service-only, not routed, revokes before creating (non-atomic) |
| Expiry | **Implemented but incompletely verified** | Default 90 days; past or unbounded `expiresAt` accepted; expired keys still count against the active-key cap |
| Scopes | **Implemented but incompletely verified** | `analytics:query`, `datasets:read`, `dashboards:read`; `connectors:read` allow-listed but unused |
| Tenant and dataset authorisation on external routes | **Implemented but incompletely verified** | Tenant from key; dataset ownership checked; engine tenant filter |
| Rate limiting | **Partially implemented** | External 60/min and embed 120/min per IP, but the global 300/15 min limiter runs first, stores are in-memory, and limits are per IP rather than per key ({{API:limiter-order}}) |
| Usage metering | **Broken** | `apiCallsPerDay` is consumed once at key creation, on a counter that never resets, and not per call ({{API:metering}}) |
| Audit | **Implemented but incompletely verified** | Create/update/revoke audited; actor attribution is null (`req.user._id` vs `req.user.id`); every authenticated call's `lastUsedAt` write produces an audit row ({{API:audit-noise}}) |
| Error contract | **Partially implemented** | Cap breaches throw plain `Error` → 500; documented API-key error codes are never emitted ({{API:500s}}) |
| Embed token mint / list / revoke | **Broken** | Wrapper defect and missing tenant |
| Public embed read | **Broken** | Wrapper defect; when fixed, it returns the full dashboard document including share recipients' emails ({{API:embed-leak}}) |
| Origin binding, audience, single-use, locked parameters | **Missing** | Tokens are opaque bearer values valid from any origin for up to 7 days |
| Tenant suspension | **Missing** | Neither API keys nor embed tokens check tenant status, and suspension does not revoke them ({{API:suspension}}) |
| CORS for embed | **Configured permissively** | `EMBED_CORS_ALLOW_ALL` defaults to `true` in code (`backend/src/config/env.js:214`) and reflects any origin (`backend/src/routes/embed.routes.js:61-64`) ({{API:cors-default}}); no preflight handler on the public route ({{API:preflight}}) |
| Token handling in logs | **Defect** | Embed tokens live in the URL path and are written to the HTTP access log ({{API:token-in-url}}) |
| Embeddable artefact (iframe page or script) | **Missing** | The "embed" is a bare JSON endpoint; there is no iframe page, script, theming, or resize protocol ({{API:no-embed-product}}) |
| Integrator documentation | **Missing** | No OpenAPI document, SDK or embed guide for customers |
| Frontend API Keys and Embed pages | **Broken** | Lists always empty (backend puts the page object under `data`); embed preview expects a different response shape; the UI allows TTLs under the 60 s minimum and lists draft dashboards ({{API:list-contract}}, {{API:preview-contract}}) |
| Tests | **Missing** | No backend test file exercises `/api-keys`, `/external`, `/embed` or `apiKeyAuth` ({{API:no-tests}}) |
| Privileged keys in the browser bundle | None found | Only `VITE_RAZORPAY_KEY_ID` (publishable, unused) is declared |

## 2. Target embedding model

Two established products converge on the same pattern: Metabase static embedding signs a short-lived JWT on the host application's server that names the resource and locks filter values, and Superset's guest tokens are minted server-side by a service account, carry row-level restrictions, and are bound to configured allowed origins. Analivo should adopt that pattern.

```mermaid
sequenceDiagram
  participant U as End user browser
  participant HA as Customer app backend
  participant A as Analivo API
  participant E as Analivo embed page (iframe)
  HA->>A: POST /v1/embed/sessions (X-Api-Key with embed:mint) {resource, lockedFilters, origin, ttl}
  A-->>HA: { embedUrl, expiresAt } (signed, single-use exchange code)
  HA-->>U: page with <iframe src=embedUrl>
  U->>E: load iframe (CSP frame-ancestors = configured origins)
  E->>A: exchange code -> short-lived embed session (5-15 min, refreshable via host)
  E->>A: GET dashboard/widget data (embed session; same-site to Analivo)
  A-->>E: data filtered by lockedFilters + tenant
```

| Element | Design |
|---|---|
| Embed configuration | Tenant-level `EmbedConfig`: allowed origins (exact scheme+host), allowed resources, default TTL, theme, allowed interactions (filters, drill, export off by default). Audited changes |
| Minting | Only from the customer's server with an API key holding a new `embed:mint` scope. Never from the browser, never with a long-lived secret in page code |
| Token contents | tenant, resource id and type, locked filter values (row-level restriction such as `customer_id = 42`), allowed origin, expiry (minutes, not days), unique id; signed with a dedicated key (not `JWT_SECRET`) and rotatable |
| Delivery | An iframe page served by the Analivo frontend. The page's CSP `frame-ancestors` lists the configured origins; data calls go from the Analivo origin to the API, so **no wildcard CORS is needed** and `EMBED_CORS_ALLOW_ALL` can default to `false` |
| URL hygiene | A one-time exchange code in the URL, swapped for an in-memory embed session; access-log redaction for embed paths |
| Authorisation on every data call | Embed session valid and unexpired; tenant `active`; resource still published; locked filters merged server-side and not overridable; only the embedded resource and its widgets reachable |
| Revocation | Revoke an embed config, a resource's embedding, or all embeds for a tenant; suspension of the tenant revokes everything |
| Usage and limits | Per-tenant embed view metering; per-session and per-tenant rate limits; abuse detection on unusual origins or volumes (document 11) |
| Public share links | The existing opaque-token model can remain for "anyone with the link" sharing of a published dashboard, with short default TTL, explicit warning, view-only data, and no recipient emails in the payload |

## 3. Target developer API

1. **Fix the basics:** mount `resolveTenant` (and pass `req.tenant.id`, not the object) on `/api-keys` and `/embed/tokens`; make repositories throw when `tenantId` is missing instead of dropping the filter; fix the `{ dashboard }` wrapper usage; add HTTP integration tests for every route, including cross-tenant attempts.
2. **Key lifecycle:** create with mandatory expiry (maximum configurable, for example 365 days), name, scopes and optional allowed IP ranges; rotate by creating a new key that overlaps the old one for a grace period; revoke immediately; show last used time and per-key usage.
3. **Per-key limits and metering:** rate limits keyed by key id in Redis; `apiCallsPerDay` incremented per call with a daily period; quota errors as 429 with `Retry-After`.
4. **Error contract:** documented machine-readable codes (`INVALID_API_KEY`, `INSUFFICIENT_SCOPE`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `VALIDATION_FAILED`, `NOT_FOUND`), request id in every response, never a 500 for a client error.
5. **Versioning:** keep `/api/v1`; publish a deprecation policy; add response headers for deprecation and sunset dates when needed.
6. **Documentation:** an OpenAPI 3.1 document generated from the validators, a reference site, copy-paste examples (cURL and Node), an embed quick-start, and a test-mode key type that only reads a sample dataset.
7. **Tenant status:** API keys and embed sessions are rejected while the tenant is not `active`, and lifecycle transitions revoke or suspend them (document 10 §4).

## 4. CORS and headers

- The main API's CORS policy is sound in production: an allow-list with credentials, and the production gate rejects `*` and localhost (`backend/src/config/env.js:383-388`).
- The custom CSP in `backend/src/app.js:84-95` overwrites helmet's and drops `frame-ancestors`; for an API that serves only JSON this is low impact, but it should be restored (`frame-ancestors 'none'`) for API responses. The embed iframe page (frontend) needs its own CSP with configured `frame-ancestors`.
- CORS is not authentication. Even with an origin allow-list, every embed and external request must be authorised by its token or key as above.

## 5. Findings in this area

{{API:no-tenant}}, {{API:idor}}, {{API:wrapper}}, {{API:embed-leak}}, {{API:suspension}}, {{API:cors-default}}, {{API:token-in-url}}, {{API:preflight}}, {{API:metering}}, {{API:limiter-order}}, {{API:audit-noise}}, {{API:500s}}, {{API:list-contract}}, {{API:preview-contract}}, {{API:no-tests}}, {{API:no-embed-product}}. Full details are in `19-findings-register.md`.

## Sources

- Metabase, static embedding: https://www.metabase.com/docs/latest/embedding/static-embedding
- Metabase, securing embeds: https://www.metabase.com/learn/metabase-basics/embedding/securing-embeds
- Apache Superset, embedding: https://superset.apache.org/user-docs/using-superset/embedding
