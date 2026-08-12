# Changelog

All notable changes to the SaaS Analytics Platform backend are documented
here. Dates are ISO 8601.

---

## [Unreleased] - Phase 2

### Sprint 6 — Dashboards & Widgets (close: 2026-08-12)

Sprint 6 ships the first user-facing analytics surface on top of the
Sprint 5 engine: tenant-scoped dashboard + widget authoring, lifecycle,
sharing, and cached execution. Suite grew 325 → 353 tests.

> **Re-scope note:** the original Sprint 6 plan was Master Data. Master
> Data moved into [Sprint 5](#sprint-5--analytics-engine--master-data-close-2026-08-12)
> (analytics engine + reference catalogue); Sprint 6 delivered Dashboards
> & Widgets.

#### Added (models)

- `src/models/Dashboard.js` — real schema (`DASHBOARD_STATUSES` draft/
  published/archived, `DATE_RANGE_PRESETS` today/yesterday/last_7_days/
  last_30_days/this_month/previous_month/custom, share entries
  `{email, role, expiresAt}`, `DASHBOARD_LIMITS` with
  `MAX_WIDGETS_PER_DASHBOARD` = 30 + `WIDGET_CACHE_TTL_SEC` = 300;
  tenantScope, softDelete, paginate, optimisticConcurrency, audit).
- `src/models/Widget.js` — real schema (`WIDGET_TYPES` kpi/table/bar/
  line/area/pie, `QUERY_FIELDS` whitelist for the safe query contract,
  `WIDGET_LIMITS`; all five plugins, index `{tenantId, dashboardId}`).

#### Added (services)

- `src/services/dashboard.service.js` — dashboard CRUD + `publish` /
  `duplicate` / soft-delete, email-grant `shareDashboard`/`revokeShare`
  (audited), widget CRUD scoped by `(tenantId, dashboardId)`,
  `executeWidget` + `viewDashboard` (partial failures per-widget).
  Owns query-contract whitelisting, layout/filter sanitisation, and the
  cache-key policy (widget/dashboard `updatedAt` revisions bust cached
  results; analytics TTL otherwise governs).
- `src/services/widget.service.js` — six widget types with layout +
  query-contract validation.

#### Added (routes / controller / validator)

- `src/routes/dashboard.routes.js` — real, authenticated `GET/POST/PATCH/
  DELETE` `/api/v1/dashboards/*` incl. `/:id/publish`, `/:id/duplicate`,
  `/:id/share`, `/:id/execute`, `/:id/widgets/*` + widget execute —
  behind `authenticate → resolveTenant → permission('dashboards',
  <action>)`; running a widget additionally requires `analytics.view`.
- `src/controllers/dashboard.controller.js` +
  `src/validators/dashboard.validator.js` — thin handlers + schemas.

#### Added (testing)

- `tests/dashboards/dashboard.service.test.js` (9) — CRUD/lifecycle/share.
- `tests/dashboards/widget.service.test.js` (8) — widget CRUD + types.
- `tests/dashboards/dashboard.execution.test.js` (7) — engine
  integration, cache miss→hit + edit-bust, tenant isolation, fail-closed
  (404 unknown, 400 foreign/deleted dataset), date-preset application,
  partial failures.
- `tests/dashboards/dashboard.routes.integration.test.js` (4) — HTTP
  end-to-end lifecycle + 401/403/422 + cross-tenant 404.

#### Fixed (CI guard)

- `scripts/ci/check-routes.js` — `isCompliant()` now recognises local
  wrapper helpers that embed an auth middleware in their body (the
  dashboards `guarded(...)` wrapper spreads `[authenticate, resolveTenant,
  permission(...)]`), instead of requiring a literal `authenticate` in
  every route argument. Verified against a temporary unprotected route
  (still flagged) and the real routes (pass).

#### Added (documentation)

- `src/docs/phases/sprint-6.md` rewritten as the Dashboards & Widgets
  completion record (was the stale Master Data plan); `STATUS.md`,
  `src/modules/analytics/STATUS.md` +
  `src/modules/analytics/dashboards/STATUS.md`, `CHANGELOG.md` +
  `AI_CONTEXT.md` updated for the sprint close.

### Sprint 5 — Analytics Engine + Master Data (close: 2026-08-12)

Sprint 5 ships the tenant-scoped analytics query engine over ingested
connector rows (filters, date presets, pagination, `groupBy` + metrics,
cached execution, run history) and the platform-wide reference catalogue.
Suite grew 285 → 325 tests.

> **Re-scope note:** the original Sprint 5 plan was "Platform: settings,
> feature flags, notifications" surfaces. The engines already shipped
> inside Sprint 3 (`setting.service.js` / `featureFlag.service.js`), so
> the standalone surfaces stayed fail-closed stubs and Sprint 5 delivered
> the analytics engine + master data (which Sprint 6's dashboards need).

#### Added (engine + service)

- `src/services/analytics.engine.js` — compiles a normalised query into a
  single MongoDB aggregation over `ConnectorRow` (no Node materialisation):
  filters (`eq, neq, in, nin, gt, gte, lt, lte, exists`), `filtersOp`
  and/or, date-range window, metrics (`count, sum, avg, min, max`),
  `groupBy` aggregation (`groupMode: 'grouped'`) or raw rows
  (`groupMode: 'raw'`), sort, pagination (default 50, max 200),
  projection. Always injects `tenantId` + `deletedAt: null` into the
  leading `$match` (aggregate bypasses the tenantScope plugin).
- `src/services/analytics.service.js` — cached `query` (cache keyed by
  `tenantId` + full query hash), `getQuery`/`listQueries` run history,
  `scheduleExport` async export.
- `src/services/analytics.cache.js` — `buildCacheKey` + `cachedQuery`
  (+ `invalidate`).
- `src/services/analytics.scheduler.js` — export scheduling.
- `src/repositories/analytics.repository.js` — history persistence
  (best-effort; a cache miss that computed a result never fails on the
  metadata write).

#### Added (master data)

- `src/models/MasterData.js` + `src/services/masterData.service.js` —
  category-discriminated reference catalogue; admin write, public cached
  read (`master-data:<category>`).
- `src/routes/master-data.routes.js` — `GET /:catalogue` (public,
  cached) + `GET /:catalogue/:id` + admin `POST`/`PATCH`/`DELETE`;
  `POST /:catalogue/import|export` remain 501.

#### Added (routes / controller / validator)

- `src/routes/analytics.routes.js` — `GET /` (run cached query),
  `GET /queries`, `GET /queries/:id`, `POST /export` — behind
  `authenticate → resolveTenant → permission('analytics', <action>)`.
- `src/models/AnalyticsQuery.js` — historical run records.
- `src/controllers/analytics.controller.js`,
  `src/controllers/masterData.controller.js`, `src/validators/
  analytics.validator.js` + `masterData.validator.js`.

#### Added (testing)

- `tests/analytics/analytics.engine.raw.test.js` (2), `analytics.engine.filters.test.js`
  (10), `analytics.engine.aggregations.test.js` (6) — engine contract.
- `tests/analytics/analytics.cache.test.js` (3), `analytics.service.test.js`
  (6), `analytics.controller.test.js` (5) — cache + facade + handlers.
- `tests/master-data/masterData.test.js` (8) — catalogue CRUD + cache +
  admin gate.

#### Added (documentation)

- `src/docs/phases/sprint-5.md` rewritten as the Analytics Engine +
  Master Data completion record; `STATUS.md` + module STATUS files
  updated.

### Sprint 4 — Connector Platform (close: 2026-08-12)

Sprint 4 ships the persistence layer and the first two concrete
providers on the Phase 1.1 connector framework: tenant-scoped connector
CRUD (config encrypted at rest), CSV upload + stream-parse ingest, the
inbound HMAC-verified webhook surface, and the idempotent sync engine +
queue consumer. Suite grew 232 → 285 tests.

#### Added (models)

- `src/models/Connector.js` — tenant-scoped, `config` = encrypted
  envelope, `webhookToken` (unique sparse) for webhook type, plain
  `fieldMapping`, `lastSyncedAt`/`lastError`/`errorCount`.
- `src/models/ConnectorRow.js` — ingested records, unique
  `{connectorId, sourceRowId}` for idempotent replays.

#### Added (repositories)

- `src/repositories/connector.repository.js` — list/findById/
  findByWebhookToken/create/update/bumpError/remove/countByType.
- `src/repositories/connectorRow.repository.js` — list/count/upsertRows/
  deleteForConnector.

#### Added (connectors + shared)

- `src/modules/connectors/csv/` — `csv.connector.js` (stream-parse with
  backpressure) + `csv.parser.js`.
- `src/modules/connectors/webhook/webhook.connector.js` — inbound route
  with raw-body + HMAC-SHA256 signature verification (JSON parsing breaks
  the signature).
- `src/modules/connectors/shared/` — `field-mapping.js`, `sync-engine.js`
  (idempotent upsert on `{connectorId, sourceRowId}`), `validators.js`,
  `errors.js`.

#### Added (service + queue + routes)

- `src/services/connector.service.js` — CRUD, config encryption at rest,
  validate/preview/trigger-sync/delete, row listing, registered types.
- `src/queues/connector.queue.js` — real consumer: resolves the
  connector, runs the sync engine, upserts rows idempotently.
- `src/routes/connector.routes.js` — `/api/v1/connectors/*` CRUD +
  validate + rows + CSV preview/sync behind `authenticate → resolveTenant
  → permission('connectors', …)`.
- `src/routes/webhook.routes.js` — inbound `/webhooks/:webhookToken`
  (public, signature-verified).
- `src/controllers/connector.controller.js`, `webhook.controller.js`,
  `src/validators/connector.validator.js`.

#### Added (testing)

- `tests/connectors/connector.service.integration.test.js` (6),
  `tests/modules/connectors/connectors.test.js` (8),
  `tests/modules/connectors/csv/csv.parser.test.js` (6),
  `tests/modules/connectors/shared/field-mapping.test.js` (9),
  `tests/modules/connectors/shared/sync-engine.test.js` (6),
  `tests/modules/connectors/shared/validators.test.js` (10),
  `tests/modules/connectors/webhook/webhook.verify.test.js` (8).

#### Added (documentation)

- `src/docs/phases/sprint-4.md` marked complete; `STATUS.md` + connector
  module STATUS files updated.

### Sprint 3 — Multi-Tenancy (close: 2026-08-07)

Sprint 3 ships the tenant as a first-class lifecycle object: provision,
onboard, suspend/restore/disable/archive (with a session + RBAC-cache
cascade), a login/refresh tenant-status gate, tenant settings with
effective inheritance + secret redaction, and a feature-flag catalogue.
Suite grew 218 → 232 tests.

#### Added (models)

- `src/models/Setting.js` — real schema (`SCOPES`, `TYPES`, soft-delete,
  `tenantScope({ optional: true })`, paginate, optimistic-concurrency,
  audit).
- `src/models/FeatureFlag.js` — real schema (`ROLLOUT_STRATEGIES`,
  `VALUE_TYPES`, audit, soft-delete, paginate, optimistic-concurrency).
- `src/models/Tenant.js` — extended with lifecycle (`pending`/`active`/
  `suspended`/`disabled`/`archived`), `onboardingStatus`, `ownerId`,
  lifecycle timestamps + reasons, immutable `slug`.

#### Added (repositories)

- `src/repositories/setting.repository.js` — coerce, upsert-key, list.
- `src/repositories/featureFlag.repository.js` — enabled lookup + CRUD.
- `src/repositories/tenantStatistics.repository.js` — tenant activity.
- `src/repositories/tenant.repository.js` — lifecycle + counts.

#### Added (services)

- `src/services/tenant.service.js` — facade: create/list/get/update,
  lifecycle, initialize, statistics, settings, members, billing,
  `changeOwner`.
- `src/services/tenantInitialization.service.js` — idempotent onboarding
  (modules + permissions + platform settings + feature flags + the four
  default roles `Owner`/`Admin`/`Manager`/`Viewer` + owner user), flips
  `pending → active`/`ready`.
- `src/services/tenantLifecycle.service.js` — suspend/restore/disable/
  archive with the status graph, session revocation
  (`revokeAllForTenant`) and RBAC-cache invalidation.
- `src/services/tenantSettings.service.js` — grouped effective settings,
  idempotent platform-default seed, tenant override upsert, read-only +
  unknown-key rejection.
- `src/services/setting.service.js` — typed values, `platform` + `tenant`
  scopes, secret redaction, effective inheritance (tenant > platform >
  default), cache key `settings:<scope>:<holder>:<key>` (TTL 60s) with
  per-key invalidation.
- `src/services/featureFlag.service.js` — default catalogue seed,
  rollout strategies (`all`/`tenantId`/`percentage`/`attribute`),
  deterministic bucketing, cached enabled-catalogue
  (`feature-flag:enabled`, TTL 60s).
- `src/services/tenantStatistics.service.js` — aggregates over
  `User`/`Session`/`AuditLog` only.
- `src/modules/iam/auth/auth.service.js` — **tenant-status gate**: login
  rejects unknown/malformed tenant ids generically and returns 403 for
  non-`active` tenants; refresh revokes the session family when the
  tenant is inactive.

#### Added (routes / controller / validator)

- `src/controllers/tenant.controller.js` + `src/validators/tenant.validator.js`
  — thin handlers + create/list/update/lifecycle/initialize/members/
  settings/owner schemas.
- `src/routes/tenant.routes.js` — real, admin-gated `POST/GET/PATCH/...`
  `/api/v1/tenants/*` behind `adminAuth` + `permission('iam.tenants',
  <action>)`.

#### Fixed (cache incident)

- `src/cache/memory.js` `getOrSet` no longer memoizes `null`/`undefined`
  misses (matching Redis semantics) — a missing tenant setting override
  was cached negatively and later ignored until TTL expiry.
- `tenantSettings.updateGroup` now invalidates the `resolveEffective`
  cache per overridden key on write.

#### Added (testing)

- `tests/tenants/tenant.integration.test.js` (13 tests) — create/detail/
  list, status-rejection, onboarding + owner login + role seeding,
  idempotent re-init, suspend → login 403 + session cascade, restore,
  disable/archive + terminal 409, members, settings inheritance +
  redaction + read-only rejection, feature-flag rollout, stats + billing,
  changeOwner.
- `tests/services/setting.service.test.js` (10 tests) — coercion,
  redaction, inheritance, cache invalidation, read-only protection.

#### Added (documentation)

- `src/docs/backend/multi-tenancy.md` updated to `Implemented`;
  `src/docs/phases/sprint-3.md` DoD checked; `STATUS.md` + module
  READMEs/STATUS updated for the sprint close.

### Sprint 2 — IAM: Admins, Tenants, Users + RBAC (close: 2026-08-07)

Sprint 2 turns the platform *organisational*: Platform Admins manage
admins/tenants/users, dynamic RBAC ships (modules, permissions, roles),
and the permission/role/admin/tenant middleware becomes real. Suite grew
124 → 218 tests.

#### Added (models)

- `src/models/Module.js`, `src/models/Permission.js`, `src/models/Role.js`,
  `src/models/RolePermission.js`, `src/models/UserRole.js`,
  `src/models/AdminRole.js` — the RBAC model set, all with the shared
  plugin set. `src/models/AuditLog.js` — the Sprint 7 consumer's source.

#### Added (services + cache)

- `src/services/permission.service.js`, `src/services/role.service.js`,
  `src/services/admin.service.js`, `src/services/auditLog.service.js`,
  `src/services/user.service.js`.
- `src/services/rbac.cache.service.js` — resolved-permission set cached at
  `iam:rbac:<scope>` (5-min TTL, invalidated on write); default deny.
- System roles seeded (`Owner`/`Admin`/`Manager`/`Viewer` permission keys).

#### Added (middleware, real)

- `src/middleware/permission.middleware.js` — `<module>.<action>` guard,
  cached 60s, invalidated on write.
- `src/middleware/rbac.middleware.js`, `src/middleware/modulePermission.middleware.js`,
  `src/middleware/audit.middleware.js` — real enforcement replacing the
  fail-closed stubs; `src/middleware/tenantIsolation.middleware.js` real.

#### Added (routes / controllers / validators)

- `/roles/*`, `/permissions/*`, `/admin/admins/*`, `/users/*`,
  `/tenants/:tenantId/users/*`, `/audit-logs/*` — real, admin-gated,
  validated; `src/controllers/{role,permission,admin,user,auditLog}.controller.js`,
  `src/validators/{role,permission,admin,user}.validator.js`.

#### Added (testing)

- `tests/routes/rbac.integration.test.js` (8 tests), `tests/rbac/`
  (services.integration, 7 tests), `tests/middleware/rbac.middleware.test.js`
  (4 tests), `tests/middleware/auth.test.js` (11 tests),
  `tests/validators/rbac.test.js` (8 tests) — permission resolution, RBAC
  cache, `permission`/`denyIf` enforcement, gates.

### Sprint 1 — Authentication (close: 2026-08-06)

Sprint 1 ships the first user-visible feature: login, refresh, logout and
password reset for **both** portals (`/auth/*` tenant users,
`/admin-auth/*` platform admins), plus TOTP MFA for `super_admin` and
persisted account lockout. Suite grew 73 → 124 tests (51 new, incl.
end-to-end integration against `mongodb-memory-server`).

#### Added (models)

- `src/models/User.js`, `src/models/Admin.js`, `src/models/Tenant.js`,
  `src/models/Session.js`, `src/models/LoginAttempt.js` — the five auth
  models, all with the shared plugin set (tenantScope, softDelete,
  paginate, optimisticConcurrency, audit).

#### Added (IAM auth module)

- `src/modules/iam/auth/auth.service.js` — login (generic errors, no
  enumeration), refresh (rotation + replay ⇒ whole-family revocation),
  logout, lockout via `LoginAttempt`.
- `src/modules/iam/auth/session.service.js` — session lifecycle: create /
  rotate / revoke (idempotent) / revokeAllForActor / markExpired;
  **deterministic** refresh-token hashing (salt = SHA-256(token)) so the
  repository can look up `Session` by hash.
- `src/modules/iam/auth/mfa.service.js` — two-step TOTP enrolment + verify
  (`otplib`); secret AES-256-GCM encrypted; enforced for `super_admin`.
- `src/modules/iam/auth/password.service.js` — forgot (no enumeration) /
  reset with `purpose` + audience-gated token; reset revokes the session
  family.
- `src/modules/iam/auth/{auth,mfa,password}.controller.js` — thin
  controllers; `src/validators/auth.validator.js`,
  `src/validators/admin.validator.js` — request schemas.

#### Added (middleware + routes, real)

- `src/middleware/auth.middleware.js` — real `authenticate` /
  `optionalAuthenticate`; `authorize(...)` fails closed until RBAC.
- `src/middleware/adminAuth.middleware.js` — real `adminAuth` /
  `adminAuthOptional`.
- `src/middleware/tenant.middleware.js` — real `resolveTenant`
  (`X-Tenant-Id` header → JWT `tenantId` claim).
- `src/routes/auth.routes.js` + `src/routes/admin-auth.routes.js` — real
  handlers behind `strictLimiter` + `validateRequest`.

#### Changed (hardening)

- `src/utils/password.js` — **KDF seam**: Argon2id (default) plus
  `PASSWORD_KDF=scrypt` (Node built-in, portable) with self-describing PHC
  hashes; `verify()` dispatches by prefix and never loads `argon2` for
  scrypt hashes (fixes the native-binary crash on some Windows setups).
- `src/config/env.js` — `PASSWORD_KDF` validated (`argon2` | `scrypt`).
- Removed hardcoded `DUMMY_HASH` from `auth.service.js`; timing
  equalization now derives a dummy hash from the active KDF.
- `package.json` — `test` runs `scripts/ci/run-tests.js` (scrypt mode);
  `test:argon2` exercises the real Argon2id KDF.

#### Added (testing)

- `tests/helpers/http.js` — start/stop the Express app, cookie capture +
  replay, `getSetCookie`.
- `tests/helpers/totp.js` — RFC 6238 TOTP code minting for MFA tests.
- `tests/auth-flow.integration.test.js` — tenant-portal end-to-end
  (login / me / refresh rotation / replay / logout / lockout / fail-closed
  tenant header).
- `tests/admin-auth-mfa.integration.test.js` — admin-portal end-to-end
  (login / me / two-step MFA with real TOTP / refresh).
- `tests/password-reset-session.integration.test.js` — forgot (no
  enumeration) / reset revokes sessions.
- `tests/session-lifecycle.integration.test.js` — service + repository
  level session lifecycle.
- `tests/validators/auth.test.js` — auth/admin validator schemas.
- `tests/utils/password.test.js` — rewritten for both KDFs.

#### Added (config)

- `PASSWORD_KDF` in `src/config/env.js` + `.env.example` (documented as
  `scrypt` for local/test use; production stays `argon2`).

#### Added (documentation)

- `src/docs/backend/authentication.md` updated to `Implemented`;
  `src/docs/phases/sprint-1.md` DoD checked; `STATUS.md` +
  `src/modules/iam/auth/STATUS.md` + module `README.md` + `tests/README.md`
  + `AI_CONTEXT.md` updated for the sprint close.

### Sprint 0 — Implementation Foundation

Sprint 0 wires every shared utility, infrastructure provider, Mongoose plugin
and CI guardrail that the next nine sprints depend on. No business logic is
shipped: every route is still fail-closed `501`.

#### Added (utilities)

- `src/utils/jwt.js` - `jose`-based JWT signing/verification with audience +
  issuer awareness, typed `JwtError` (`EXPIRED`, `INVALID`, `INVALID_SIGNATURE`).
- `src/utils/password.js` - Argon2id hashing/verification with `needsRehash`
  detection.
- `src/utils/id.js` - UUIDv4 + ULID + prefixed IDs + short URL-safe tokens +
  canonical `PREFIXES` map.
- `src/utils/encryption.js` - High-level credential encryption (AES-256-GCM
  with versioned envelope + context-scoped key derivation). Placeholder
  `rotateKeys()` returns `{ rotated: 0 }`; the seam for KMS swap is in place.
- `src/utils/idempotency.js` - Deterministic SHA-256 idempotency-key helpers
  (header-or-body fingerprint with stable serialisation).

#### Added (cache layer)

- `src/cache/memory.js` - Full in-memory driver with TTL, `getOrSet`,
  `increment`, `flushAll`, `close`.
- `src/cache/redis.js` - `ioredis`-backed driver with the same surface,
  exponential SCAN-based flush, lazy connection.
- `src/services/cache.service.js` - The single public interface; applies a
  stable `cache:` prefix; auto-selects provider from `REDIS_URL`.

#### Added (queue layer)

- `src/queues/memory.queue.js` - In-memory transport with exponential
  backoff, `enqueue`, `schedule`, `consume`, lifecycle events.
- `src/queues/index.js` - BullMQ transport (selected when `REDIS_URL` is
  set) on top of the same handle surface.
- `src/queues/connector.queue.js`, `email.queue.js`, `analytics.queue.js` -
  per-queue contracts + `getQueue()` helpers.
- `src/services/queue.service.js` - The single public interface; provides
  typed helpers (`enqueueConnectorSync`, `enqueueEmail`, `enqueueAnalytics`).

#### Added (storage layer)

- `src/storage/localStorage.js` - Filesystem driver with path-traversal
  protection, recursive directory creation, listing, write-stream,
  presigned-URL placeholder.
- `src/storage/s3Storage.js` - `@aws-sdk/client-s3`-backed driver with the
  same surface; supports S3-compatible endpoints (MinIO, R2).
- `src/services/storage.service.js` - The single public interface;
  `put`/`get`/`del`/`exists`/`list`/`createWriteStream`/`presignedUrl`
  + `putJson`/`getJson` helpers.

#### Added (email layer)

- `src/services/mail.transport.js` - SMTP transport factory; falls back to
  noop `jsonTransport` when `MAIL_PROVIDER=none`.
- `src/services/email.service.js` - The single public interface; `send`,
  `sendMany`, `verify`, `captureInto` (for tests).

#### Added (Mongoose plugins)

- `src/models/plugins/tenantScope.js` - Per-request tenant filter on reads +
  save-side enforcement of `tenantId`; `Model.useScope({ tenantScope: '*' })`
  for support admins.
- `src/models/plugins/softDelete.js` - `deletedAt`/`deletedBy` fields; reads
  auto-filter; `doc.softDelete()`, `doc.restore()`, `Model.withDeleted()`,
  `Model.onlyDeleted()`.
- `src/models/plugins/paginate.js` - `mongoose-paginate-v2` wrapper with
  platform defaults.
- `src/models/plugins/optimisticConcurrency.js` - `mongoose-update-if-current`
  wrapper using `__v`.
- `src/models/plugins/audit.js` - Domain-event emitter (`create`, `update`,
  `softDelete`, `restore`) consumed by the Sprint 7 audit service.

#### Added (middleware)

- `src/middleware/idempotency.middleware.js` - `X-Idempotency-Key`-aware
  middleware with cached outcome replay, in-flight coalescing and a 64 KiB
  per-key cap. Fails closed when the cache is unavailable.

#### Unified

- `src/middleware/auth.middleware.js` - Now uses `ApiError.notImplemented()`
  for consistent error codes (`ERROR_CODES.NOT_IMPLEMENTED`).
- `src/routes/auth.routes.js` - Now mirrors the stubbed-with-hint pattern
  used by `admin-auth.routes.js`.

#### Added (config)

- `STORAGE_PROVIDER`, `STORAGE_BASE_DIR`, `S3_*` settings in
  `src/config/env.js` and `.env.example`.
- `ENCRYPTION_KEY`, `ENCRYPTION_ALGORITHM`, `ENCRYPTION_KEY_VERSION` for
  separate at-rest key material.

#### Added (testing)

- `tests/helpers/mongo.js` - `mongodb-memory-server` lifecycle helpers
  (`startMongo`, `stopMongo`, `resetMongo`).
- `tests/helpers/factories.js` - Document factories for every model name
  referenced by future tests.
- `tests/helpers/auth.js` - Bearer token minting + tenant header helpers.
- `tests/helpers/index.js` - Shared `useMongo()` hook + assertion helpers.
- Unit tests for every new utility + driver + plugin
  (`tests/utils/*.test.js`, `tests/cache/memory.test.js`,
  `tests/queues/memory.test.js`, `tests/storage/local.test.js`,
  `tests/services/email.test.js`, `tests/models/plugins.test.js`).

#### Added (CI)

- `scripts/ci/check-stubs.js` + `stubs-allowlist.js` - Fails the build when
  a file uses `notImplementedStub` without an allowlist entry.
- `scripts/ci/check-routes.js` - Fails when a real route handler is mounted
  without an auth middleware or an explicit exemption.
- `scripts/ci/check-models.js` - Fails when a model defines `mongoose.model`
  without importing any shared plugin.
- `scripts/ci/check-config.js` - Fails when a module reads `process.env`
  outside `src/config/` (and `tests/`).
- `scripts/ci/check-readme-sync.js` - Fails when module READMEs / STATUS.md
  are missing or out of sync.
- `scripts/ci/run-all.js` - Single entry point wired to `npm run ci:guards`.

#### Added (documentation)

- `src/docs/ARCHITECTURE.md` - System diagram + request lifecycle + module
  dependency rules.
- `src/docs/DECISIONS.md` - ADRs for every Sprint 0 design choice.
- `src/docs/errors.md` - Error envelope contract and code catalogue.
- `STATUS.md` per module folder tracking implementation status.

---

## Phase 1.2 - Architecture

### Added

- Connector framework (`BaseConnector`, `ConnectorRegistry`, stubs).
- Real Express app (`src/app.js`, `src/server.js`).
- Real configuration layer (`src/config/env.js`, `constants.js`,
  `database.js`, `logger.js`, `cors.js`, `mail.js`, `socket.js`,
  `scheduler.js`).
- Real error envelope (`ApiError`, `ApiResponse`, `errorHandler`).
- WebSocket bootstrap (`src/websocket/index.js`, `events.js`, `rooms.js`).
- Real validators engine (`src/validators/index.js`).
- Real middleware (`requestId`, `rateLimiter`, `notFound`).
- Real scheduler (`src/jobs/scheduler.js`).
- Fail-closed stubs for auth, tenant, RBAC, governance, monitoring,
  notifications, dashboards, reports, embed, alerts.
- Docker / docker-compose.
