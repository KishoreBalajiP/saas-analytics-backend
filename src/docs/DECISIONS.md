# Architecture Decision Records

Captured for Phase 2 Sprint 0. Each decision is a single ADR with
`Status`, `Context`, `Decision`, `Consequences`. New decisions follow the
same template.

---

## ADR-001: Adopt `jose` over `jsonwebtoken` for JWT

**Status:** Accepted (Sprint 0).

**Context.** The platform needs a JWT library for access tokens, refresh
challenge tokens, internal service tokens and MFA challenges.

**Decision.** Use `jose` instead of `jsonwebtoken`.

**Consequences.**
- Modern API (Promise-based), JWE/JWS support out of the box.
- Algorithm agility (`algorithms` array on `jwtVerify`).
- Key rotation is straightforward via `createRemoteJWKSet` when we
  introduce a JWKS endpoint (Phase 4+).
- Slightly larger bundle than `jsonwebtoken`, but the platform is server-
  side so this is irrelevant.

## ADR-002: Argon2id for password hashing

**Status:** Accepted (Sprint 0).

**Context.** OWASP 2024 recommends Argon2id for new systems.

**Decision.** Use the `argon2` npm package with OWASP default parameters
(`memoryCost: 19 MiB`, `timeCost: 2`, `parallelism: 1`).

**Consequences.**
- Slower than `bcrypt` (~150-300 ms on modern hardware) which is the
  point: brute-force resistance scales with hardware too.
- Parameter bumps land in one place (`utils/password.js`).
- `needsRehash()` lets us transparently upgrade older hashes.

## ADR-003: In-memory cache default; Redis when `REDIS_URL` is set

**Status:** Accepted (Sprint 0).

**Context.** Tests and dev environments should boot without an external
dependency; production needs a shared cache for multi-instance scale.

**Decision.** The cache service auto-selects: in-memory when `REDIS_URL`
is empty, Redis otherwise. Both providers implement the same surface.

**Consequences.**
- Local `npm run dev` works out of the box.
- Tests are fast and deterministic (in-memory).
- Production multi-instance requires `REDIS_URL`.
- The provider abstraction keeps feature code identical.

## ADR-004: BullMQ for durable queue transport

**Status:** Accepted (Sprint 0).

**Context.** Connector syncs, email delivery and analytics jobs need to
survive process restarts and run concurrently with retries.

**Decision.** Use BullMQ on Redis when `REDIS_URL` is set; an in-memory
transport with the same handle surface is used otherwise.

**Consequences.**
- Same queue contract everywhere; feature code never imports `bullmq`.
- Tests run without Redis.
- Production needs `REDIS_URL` set for durability.
- `@aws-sdk/lib-storage` is used for S3 multipart uploads; BullMQ
  Workers use a separate Redis connection.

## ADR-005: S3-compatible storage abstraction

**Status:** Accepted (Sprint 0).

**Context.** Production deployments store files in S3 (or MinIO / R2).
Local dev uses the filesystem.

**Decision.** `services/storage.service.js` is the only public interface;
the provider is selected via `STORAGE_PROVIDER` (`local` or `s3`).

**Consequences.**
- Feature code never imports `@aws-sdk/client-s3`.
- Switching from MinIO to AWS is a config change.
- Local driver has path-traversal protection built in.

## ADR-006: AES-256-GCM with versioned envelope for at-rest encryption

**Status:** Accepted (Sprint 0).

**Context.** Connector credentials (Atlas connection strings, OAuth
tokens, webhook secrets) need encryption at rest.

**Decision.** `utils/encryption.js` uses AES-256-GCM with a context-
scoped key (SHA-256 hash of `{tenantId, purpose}` salted with the master
secret). The envelope is `enc:v1:<ctxHash>:<iv>:<tag>:<ciphertext>`.

**Consequences.**
- A leak of the master secret alone is insufficient to decrypt any
  stored value (the context is required).
- KMS swap is a future version bump (`enc:v2:...`).
- `rotateKeys()` is a placeholder returning `{ rotated: 0 }` until the
  KMS slot is implemented (Phase 4+).
- `ENCRYPTION_KEY` is separate from `JWT_SECRET` so rotating one does
  not invalidate the other.

## ADR-007: Five shared Mongoose plugins

**Status:** Accepted (Sprint 0).

**Context.** Tenant-owned collections need consistent behaviour
(filtering, soft delete, pagination, optimistic concurrency, audit).

**Decision.** Five plugins, applied via a single import path
(`models/plugins/index.js`):
- `tenantScope` - query + save middleware
- `softDelete` - `deletedAt` / `deletedBy` + helpers
- `paginate` - `mongoose-paginate-v2` wrapper
- `optimisticConcurrency` - `mongoose-update-if-current` wrapper
- `audit` - domain-event emitter consumed by Sprint 7

**Consequences.**
- Every tenant-owned model applies the same set; CI guard
  `check-models` flags drift.
- The audit plugin emits lightweight events so Sprint 7 can subscribe
  with a non-breaking API.

## ADR-008: Idempotency middleware with cached outcomes

**Status:** Accepted (Sprint 0).

**Context.** Mobile clients retry; without server-side idempotency, a
retry can create duplicate records or trigger two charges.

**Decision.** `middleware/idempotency.middleware.js` caches response
outcomes in the cache layer under a SHA-256 key derived from the header
or body fingerprint. Fail-closed: when the cache is unavailable the
request is rejected with 503 (configurable to fail-open for reads).

**Consequences.**
- Mutations are safe to retry.
- Cache layer MUST be enabled for any route mounting the middleware.
- 64 KiB cap per stored outcome prevents cache fill by large payloads.
- Coalescing handles concurrent retries for the same key.

## ADR-009: Service-wrapper abstraction for infrastructure

**Status:** Accepted (Sprint 0).

**Context.** Feature code must not import infrastructure libraries
(`ioredis`, `bullmq`, `@aws-sdk/client-s3`, `nodemailer`).

**Decision.** Every infrastructure layer has a `src/services/<x>.service.js`
wrapper exposing a stable, typed surface. Feature code imports only from
`src/services/`.

**Consequences.**
- Switching providers (BullMQ → SQS, S3 → R2, SMTP → SES) is a single-
  file change in the wrapper.
- Unit tests can swap the driver via dependency injection in the wrapper.
- Lint rule: no feature-code import of `ioredis`, `bullmq`,
  `@aws-sdk/*`, `nodemailer`.

## ADR-010: CI guardrails

**Status:** Accepted (Sprint 0).

**Context.** Architectural rules drift when the team grows. CI should
fail when a rule is broken.

**Decision.** Five Node-based guards under `scripts/ci/`, wired to
`npm run ci:guards`:
- `check-stubs` — no orphan `notImplementedStub`
- `check-routes` — every real route has auth
- `check-models` — every model uses a shared plugin
- `check-config` — `process.env` only in `src/config/`
- `check-readme-sync` — `STATUS.md` everywhere + root docs exist

**Consequences.**
- Guardrails are zero-dependency (Node-only) so they run in any CI.
- New stubs are explicit (`stubs-allowlist.js`); removing a stub from
  the allowlist happens alongside its real implementation.

---

# Postponed Decisions (Phase 3+)

The following decisions are deliberately deferred; the architecture leaves
the slot but does not implement the feature.

- **KMS-managed encryption keys.** Envelope version bumps to `v2` with a
  KMS swap point.
- **WebAuthn / passkey auth.** TOTP only in MVP.
- **SCIM 2.0 provisioning.** Enterprise only.
- **OAuth / SAML SSO.** Enterprise only.
- **Cold archival to S3.** Hot retention only in MVP.
- **Hash-chain audit tamper-evidence.** Sequential IDs in MVP.
- **SIEM forwarder.** Hook exists in `audit` events.
- **PDF / XLSX report outputs.** CSV only in MVP.
- **Google Sheets / MongoDB connectors.** CSV + Webhook in MVP.
- **Push / outbound-webhook notifications.** In-app + email only in MVP.
- **Anomaly detection cron.** Job stub remains disabled.
- **Prometheus `/metrics`.** `/monitoring/metrics` is a placeholder.
