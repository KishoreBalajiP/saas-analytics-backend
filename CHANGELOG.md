# Changelog

All notable changes to the SaaS Analytics Platform backend are documented
here. Dates are ISO 8601.

---

## [Unreleased] - Phase 2

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
