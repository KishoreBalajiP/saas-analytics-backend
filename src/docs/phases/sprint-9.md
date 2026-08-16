# Sprint 9 — External API + API Keys + Embed + Product Delivery

> **WHAT this is:** the actual-delivery record for Sprint 9.
> **WHY it exists:** The original plan ("Analytics + Embed") was stale.
> This file records what was *actually shipped* so the next engineer
> knows the real surface.
> **HOW to use it:** read *Delivered Scope* + *Verification*.
> **WHEN to update it:** only if a factual error is found.
> **WHERE it lives:** `src/docs/phases/sprint-9.md`.

---

## Purpose

> **WHAT this is:** the delivery record for Sprint 9 — External API +
> API Keys + Embed + Product Delivery.
> **WHY it exists:** Sprint 9 completes the Phase 2 MVP by shipping the
> external-facing product surface and the full end-to-end flow.
> **HOW to use it:** read *Delivered Scope* and *Verification*.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Next sprint implementer** | Knows the real surface, not the stale plan. |
| **PM / Sales** | Has the user-visible surface to demo/validate. |
| **Interview candidate** | Can cite real endpoints, not wishlist. |

## Delivered Scope (2026-08-16)

### API Keys (tenant-scoped credentials)

- **Model:** `ApiKey` — `tenantId`, `name`, `prefix` (lookup, unique),
  `secretHash` (SHA-256), `scopes[]` (allow-list: `analytics:query`,
  `datasets:read`, `connectors:read`, `dashboards:read`), `expiresAt`,
  `status` (active/revoked), `lastUsedAt`.
- **Repository:** `apiKey.repository.js` — lean reads, findByPrefix.
- **Service:** `apiKey.service.js` — `createApiKey` (returns one-time
  `secret`), `authenticateApiKey(prefix.secret)` (constant-time verify +
  scope/expiry/revocation checks), list/get/revoke.
- **Middleware:** `apiKeyAuth.middleware.js` — `authenticateApiKey`
  (reads `X-Api-Key`, 401 opaque on all failures, attaches
  `req.apiKey` + `req.tenant`), `requireScope(scope)`.
- **Routes:** `/api/v1/api-keys` (POST/GET), `/api/v1/api-keys/:id`
  (GET/PATCH/DELETE), `/api/v1/api-keys/:id/revoke` (POST) — all behind
  `authenticate` + `permission('api_keys', …)`.

### Embed Tokens (public dashboard/widget sharing)

- **Model:** `EmbedToken` — `tenantId`, `dashboardId` (published only),
  optional `widgetId`, `tokenHash` (SHA-256), `expiresAt` (default 24 h,
  max 7 d), `status` (active/revoked), `maxUses`.
- **Repository:** `embedToken.repository.js` — lean reads, findByTokenHash.
- **Service:** `embed.service.js` — `createEmbedToken` (requires published
  dashboard), `resolveToken` (SHA-256 lookup + status/expiry + published
  re-check), `executeEmbed` (delegates to `dashboard.service.viewDashboard`
  or `executeWidget`).
- **Public route:** `GET /api/v1/embed/:token` — ci:routes-exempt,
  token-gated, reflect all Origins (no credentials), dedicated rate
  limiter. Resolves token → executes dashboard/widget via engine.
- **Management routes:** `/api/v1/embed/tokens` (POST/GET), `/:id`
  (GET), `/:id/revoke` (POST) — behind `authenticate` +
  `permission('embed', …)`.

### External API (X-Api-Key authenticated surface)

- **Service:** `externalApi.service.js` — `listDatasets`/`getDataset`
  (connector list/detail, scoped to key's tenant), `queryDataset`/
  `listDatasetRows` (analytics engine with `connectorIds:[datasetId]`),
  `getDashboard` (published only). Scope checks inline via
  `requireScope(key, scope)`.
- **Routes:** `/api/v1/external/datasets`, `/:datasetId`,
  `/:datasetId/query`, `/:datasetId/rows`,
  `/dashboards/:dashboardId` — all `authenticateApiKey` + dedicated
  rate limiter (60 req/min per IP). Scopes enforced:
  - `datasets:read` → list/get dataset
  - `analytics:query` → query/rows
  - `dashboards:read` → get dashboard

### Connectors: XLSX + MongoDB

- **XLSX provider:** `modules/connectors/xlsx/` — ExcelJS stream-parse,
  config `{ hasHeader?, sheet? }`, preview + ingest as async iterable.
- **MongoDB provider:** `modules/connectors/mongodb/` — external MongoDB
  pull-sync, config `{ uri, database, collection, filter? }`, connect
  timeouts from env (`connectors.mongodb.connectTimeoutMs` etc.),
  cursor streaming, max docs per sync capped.
- **Upload middleware:** extended for `.xlsx`/`.xls` with separate size
  cap (`CONNECTOR_XLSX_MAX_UPLOAD_MB`).
- **Connector service:** `redactConfig` for mongodb (shows host/db/coll,
  hides credentials), `previewFileUpload`/`syncFileUpload` (csv/xlsx),
  `syncMongoDB` (enqueues pull-sync), `processSyncMessage` dispatches
  to provider `ingest()`.

### RBAC Extensions

- `Module.BUILTIN_MODULES` extended with `api_keys`, `embed`.
- `tenantInitialization.service.js` seeds `api_keys.*`
  (`view/create/update/delete`) and `embed.*`
  (`view/create/delete`) into Owner/Admin/Manager/Viewer profiles.

---

## Verification (authoritative, 2026-08-16)

| Check | Result |
| --- | --- |
| `npm test` | **405 tests, 405 pass, 0 fail** |
| `npm run ci:guards` | **5 / 5 OK** |
| `npm audit` | **2 moderate** (transitive uuid in exceljs) |

---

## Files Delivered

### Models
- `src/models/ApiKey.js`
- `src/models/EmbedToken.js`
- `src/models/Connector.js` (extended `CONNECTOR_TYPES`)

### Repositories
- `src/repositories/apiKey.repository.js`
- `src/repositories/embedToken.repository.js`

### Services
- `src/services/apiKey.service.js`
- `src/services/embed.service.js`
- `src/services/externalApi.service.js`
- `src/services/connector.service.js` (extended)

### Middleware
- `src/middleware/apiKeyAuth.middleware.js`

### Controllers
- `src/controllers/apiKey.controller.js`
- `src/controllers/embed.controller.js`
- `src/controllers/externalApi.controller.js`

### Routes
- `src/routes/api-key.routes.js`
- `src/routes/embed.routes.js`
- `src/routes/externalApi.routes.js`
- `src/routes/index.js` (mounted `/api-keys`, `/external`)

### Connectors
- `src/modules/connectors/xlsx/` (xlsx.connector.js, xlsx.parser.js, index.js)
- `src/modules/connectors/mongodb/` (mongodb.connector.js, index.js)
- `src/modules/connectors/index.js` (registered both)

### Validators
- `src/validators/apiKey.validator.js`
- `src/validators/embed.validator.js`
- `src/validators/externalApi.validator.js`

### Config
- `src/config/env.js` — `security.apiKeys`, `security.embed`,
  `security.rateLimit.external`, `security.rateLimit.embed`,
  `connectors.xlsxMaxUploadBytes`, `connectors.mongodb`
- `.env.example` — all new variables documented

### Tests (integration)
- `tests/api-keys/api-key.routes.integration.test.js`
- `tests/embed/embed.routes.integration.test.js`
- `tests/external-api/external-api.routes.integration.test.js`
- `tests/connectors/xlsx.connector.test.js`
- `tests/connectors/mongodb.connector.test.js`

### Documentation
- `src/docs/STATUS.md` (updated Sprint 9 in Sprint Log, At-a-Glance,
  Test Coverage, Next Milestone, stubs table)
- `src/modules/embed/STATUS.md` (✅ Implemented)
- `src/modules/connectors/xlsx/STATUS.md` (✅ Implemented)
- `src/modules/connectors/mongodb/STATUS.md` (✅ Implemented)
- `CHANGELOG.md` (Sprint 9 entry)
- `AI_CONTEXT.md` (updated)

---

## End-to-End Product Flow (verified by integration tests)

```
1. Tenant login → JWT (req.user.tenantId)
2. Create CSV/XLSX connector or MongoDB connector (config encrypted)
3. Upload CSV/XLSX file or sync MongoDB → ConnectorRow persisted idempotently
4. Query dataset via analytics engine (filters, groupBy, metrics)
5. Build dashboard + widgets (scoped to tenant)
6. Publish dashboard
7. Create API key with scopes (analytics:query, datasets:read, …)
8. External client calls /api/v1/external/datasets/:id/query with X-Api-Key
9. Create embed token for published dashboard
10. External site loads /api/v1/embed/:token → dashboard renders without auth
```

---

## Security Contract (non-negotiable)

| Surface | Auth | Rate Limit | Scope Enforcement |
| --- | --- | --- | --- |
| `/api/v1/api-keys/*` | JWT + RBAC | global | `api_keys.*` permissions |
| `/api/v1/embed/tokens/*` | JWT + RBAC | global | `embed.*` permissions |
| `/api/v1/embed/:token` | token (SHA-256) | embed limiter (120/min) | published dashboard only |
| `/api/v1/external/*` | X-Api-Key | external limiter (60/min) | inline `requireScope` |

- API key secret returned **once** at creation; only `prefix` + `secretHash` (SHA-256) stored.
- Embed token secret returned **once**; only `tokenHash` (SHA-256) stored.
- MongoDB connector credentials **never logged**; `redactConfig` shows host/db/coll only.
- Cross-tenant access **impossible**: tenantScope plugin + middleware + service checks.

---

## Definition of Done (all ✅)

- [x] All deliverables merged.
- [x] `npm test` → 405 pass, 0 fail.
- [x] `npm run ci:guards` → 5/5 OK.
- [x] `npm audit` → 2 moderate (transitive, acceptable).
- [x] Integration tests for all new surfaces (API keys, embed, external API, XLSX, MongoDB).
- [x] Cross-tenant isolation verified (404 on foreign resources).
- [x] RBAC scope enforcement verified (403 on missing scope).
- [x] Rate limiting verified (429 on exceed).
- [x] Credential redaction verified (no secrets in API responses).
- [x] `STATUS.md` updated.
- [x] Module STATUS files updated.
- [x] `CHANGELOG.md` + `AI_CONTEXT.md` updated.

---

## What Was NOT Delivered (deferred to Phase 3)

- PDF/XLSX report rendering (storage service supports it; engine does not)
- Email channel delivery for notifications (transport exists; consumer deferred)
- Outbound webhook / push notifications
- OAuth/SAML SSO, SCIM 2.0, WebAuthn
- Multi-region / KMS / SIEM
- Custom-domain tenant routing

---

## Common Mistakes Avoided

| Mistake | How We Avoided It |
| --- | --- |
| Storing plaintext API key / embed token | SHA-256 hash only; secret returned once |
| Weak rate limiting on external surface | Dedicated limiters (external/embed) |
| Cross-tenant data leaks | tenantScope plugin + middleware + service checks on every read |
| Credential leakage in MongoDB connector | `redactConfig` + connect timeouts + no logging of URI |
| Long-lived embed tokens | Default 24 h, max 7 d, revocable, published dashboard re-checked |

---

## Related Documents

- `src/docs/STATUS.md` — daily-read status
- `src/docs/phases/sprint-8.md` — previous sprint (Governance + Monitoring + Support)
- `src/docs/phase-3.md` — what comes after Phase 2
- `src/docs/backend/api-keys.md` — API reference (to be created)
- `src/docs/backend/embed.md` — API reference (to be created)
- `src/docs/backend/external-api.md` — API reference (to be created)

---

## Last Updated

- **Sprint:** Sprint 9 close (External API + API Keys + Embed + Product Delivery)
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-16
- **Author:** Engineering (Sprint 9 close)