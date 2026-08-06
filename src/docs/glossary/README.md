# Glossary

> **WHAT this is:** the plain-English glossary of every technical
> term used in this codebase.
> **WHY it exists:** a new engineer should never have to ask what a
> word means.
> **HOW to use it:** search for a term; read the definition.
> **WHEN to update it:** when a new term enters the codebase.
> **WHERE it lives:** `src/docs/glossary/`.

---

## Purpose

> **WHAT this is:** the plain-English glossary.
> **WHY it exists:** a new engineer should never have to ask what a
> word means.
> **HOW to use it:** search for a term; read the definition.
> **WHEN to update it:** when a new term enters the codebase.
> **WHERE it lives:** `src/docs/glossary/`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **New engineer** | Has the vocabulary. |
| **Non-engineering stakeholder** | Has the shared language. |

## Current Status

> **Status:** `Maintained`.
> **Sprint:** Always.

---

## A

### Access log
A per-request HTTP trace: method, path, status, latency, request
size, response size, IP, UA, requestId, error. Never logs response
body. Sprint 7 wires the persistence.

### AES-256-GCM
A symmetric encryption algorithm with built-in authentication. We
use it in `utils/encryption.js` for connector secrets and (in future
phases) refresh-token hashes.

### Aggregation
A database query that groups + summarises rows. MongoDB's `$group`,
`$sum`, `$avg`, `$lookup` are the building blocks.

### API standards
The wire-format every endpoint must follow: success envelope,
error envelope, pagination, idempotency, auth, rate limiting.
See [`development/api-standards.md`](../development/api-standards.md).

### Argon2id
A memory-hard password hashing algorithm. OWASP-recommended.
Default parameters: `memoryCost: 19 MiB, timeCost: 2,
parallelism: 1`.

### Audit log
A record of every mutation: actor, action, resource, before,
after, reason, IP, UA, requestId, result. Captured by the `audit`
plugin; Sprint 7 wires the persistence.

### Authenticate
Middleware (`auth.middleware.js#authenticate`) that verifies the
JWT and attaches `req.actor`. Sprint 1 makes it real.

---

## B

### Backoff
The delay between retries. Exponential backoff: 1 s, 2 s, 4 s, 8 s.

### BaseConnector
The connector lifecycle contract. Every concrete connector
(`CsvConnector`, `WebhookConnector`, ...) extends it.

### BullMQ
A Redis-backed queue library built on top of `ioredis`. We use it
for connector sync, email delivery and analytics jobs.

---

## C

### Cache
A key/value store used for fast reads of slow data (RBAC maps,
settings, feature flags, idempotency outcomes).

### Cache hit
When a `get()` returns the cached value. Faster than recomputing.

### Cache miss
When a `get()` returns `null` because the key is not cached. The
caller decides whether to recompute or fail.

### CCPA
California Consumer Privacy Act. Drives a compliance surface
similar to GDPR.

### CI guardrail
A Node script under `scripts/ci/` that fails the build when an
architectural rule is broken (`check-stubs`, `check-routes`,
`check-models`, `check-config`, `check-readme-sync`).

### CIDR
Classless Inter-Domain Routing. Used in IP allow-lists.

### Connector
A `BaseConnector` subclass plus its routes, services and tests.
Examples: `CsvConnector`, `WebhookConnector`. Phase 3:
`GoogleSheetsConnector`, `MongoDbConnector`.

### Connector registry
The map of `type → Class`. Throws on duplicate / unknown.

### Controller
The HTTP layer. Thin handlers that parse input, call one service,
and return the envelope. Never contains business logic.

### CORS
Cross-Origin Resource Sharing. Configured in `config/cors.js`.

### CSRF
Cross-Site Request Forgery. Mitigated with SameSite cookies +
bearer tokens.

### CSP
Content Security Policy. A `helmet()` header.

---

## D

### Degraded mode
A boot state where the server is up but a dependency (MongoDB or
Redis) is unavailable. The health endpoint reports it explicitly.

### DLQ (Dead-Letter Queue)
A separate queue for messages that exhausted their retries. Phase 3.

---

## E

### Embedded widget
A short-lived signed token that mounts a dashboard on an external
site (the customer's intranet). Sprint 9 ships this.

### Encryption envelope
The `enc:v1:<ctxHash>:<iv>:<tag>:<ciphertext>` string produced by
`utils/encryption.js`. Versioned so KMS swap (Phase 3) is a slot-fill.

### ESM (ECMAScript Modules)
The `import` / `export` syntax. The codebase is `"type": "module"`.

---

## F

### Fail-closed
A security default where an unimplemented check rejects traffic
(`501`) rather than allowing it. Enforced by `scripts/ci/check-routes.js`.

### Fail-open
The opposite of fail-closed. Reserved for read endpoints where
downstream cache unavailability should not block the request.
Configured per route via `idempotency({ failOpen: true })`.

### Feature flag
A runtime gate on a feature. Four rollout strategies:
`all`, `tenantId`, `percentage` (hashed), `attribute`. Sprint 5.

### FlushAll
A cache operation that clears every key. Use sparingly — it
affects every instance.

### Framework
The cross-cutting infrastructure every feature uses:
configuration, error envelope, request identity, validation,
WebSocket, scheduler, queue, cache, storage, encryption, RBAC.

---

## G

### GDPR
General Data Protection Regulation. EU privacy law. Drives the
compliance surface (Sprint 7).

### Graceful shutdown
A shutdown sequence that stops accepting new requests, drains
in-flight ones, closes connections and exits with a timeout
(10 s by default).

---

## H

### HMAC
Hash-based Message Authentication Code. Used to verify inbound
webhook signatures.

---

## I

### Idempotency
The property that an operation has the same effect whether it runs
once or many times. We implement it via a deterministic
`X-Idempotency-Key` cached in the cache layer.

### Idempotent
Describes an operation that has the same effect when run multiple
times. Idempotency keys make HTTP POSTs idempotent.

### Impersonation
A Support Engineer acts as a tenant user for a short, audited
window. Mandatory reason; daily cap; double-logged (audit +
access). Sprint 8.

### Inflight coalescing
Two simultaneous requests with the same idempotency key produce
only one downstream call. Implemented in the idempotency
middleware.

### ISO 3166 / ISO 4217 / IANA TZ
The standards for country codes, currency codes and timezone
identifiers. Master data is seeded from them.

---

## J

### JWT (JSON Web Token)
A signed token that carries claims (e.g. `sub`, `aud`, `iss`,
`exp`). We use `jose`. Access token (15 min); refresh token is a
separate opaque token.

---

## K

### KMS
Key Management Service. Phase 3 introduces KMS-managed keys;
Sprint 0 ships the env-key fallback.

### KPI
Key Performance Indicator. A metric the platform tracks.

---

## L

### Lean
A Mongoose method that returns plain objects instead of Mongoose
documents. Used on hot read paths.

---

## M

### Master data
The platform-wide catalogue (countries, currencies, timezones,
plans, languages). Sprint 4.

### MFA
Multi-Factor Authentication. We ship TOTP for `super_admin` in
Sprint 1; WebAuthn is Phase 3.

### Middleware
An Express handler that runs before the route handler. The
middleware chain is fixed in `src/app.js`; per-route middleware is
declared in the route file.

### Mongoose plugin
A function that augments a schema. The shared plugin set:
`tenantScope`, `softDelete`, `paginate`, `optimisticConcurrency`,
`audit`. See `src/models/plugins/`.

### Multi-tenancy
The pattern of serving multiple customers (tenants) from a single
deployment, with strict isolation between them.

---

## N

### N+1 query
An anti-pattern where fetching N parents triggers N children
queries. Mongoose `.populate()` and `.aggregate()` can both cause
it; profile the slow queries.

---

## O

### OAuth 2.0 / OIDC / SAML SSO
Enterprise single sign-on. Phase 3.

### Optimistic concurrency
A concurrency strategy where writers do not lock; they detect
conflicts at commit time. We use Mongoose's `__v` field.

---

## P

### Pagination
The pattern of returning a slice (`page`, `limit`) of a large
result. We use `mongoose-paginate-v2`.

### PHC format
A standard string format for hashed values:
`$<algo>$v=<ver>$<params>$<salt>$<digest>`. Argon2id uses it.

### PII
Personally Identifiable Information. Sensitive fields are redacted
before persistence.

### Presigned URL
A short-lived URL that lets a browser upload or download directly
from S3 without proxying bytes through the API.

### Project Owner
The founder / irremovable super admin. The only role that holds
`super_admin` and cannot be demoted without another super + MFA +
24-hour cool-down.

---

## Q

### Queue
A FIFO list of messages processed by workers asynchronously.
HTTP returns fast; the worker does the slow work.

---

## R

### Rate limit
A throttle on the number of requests per IP / per window.
`apiLimiter` (300/15min); `strictLimiter` (20/15min) for auth.

### RBAC (Role-Based Access Control)
The engine that decides whether an actor can do an action. Roles
are collections of permissions; permissions are
`<module>.<action>` strings. The cache holds the resolved set.

### RBAC cache
The Redis key `iam:rbac:<scope>` that holds the resolved
permission set for a scope (platform or tenant). 5 min TTL;
invalidated on every role / permission write.

### RBAC engine
The code that decides whether an actor can do an action. Reads the
RBAC cache; falls back to MongoDB on miss; consults the role's
permissions.

### Refresh token
An opaque 256-bit token stored hashed at rest in `Session`. Rotated
on every refresh; family revoked on replay.

### Repository
The data-access layer. Calls Mongoose. Returns lean objects.
Applies the scope the controller / service activated.

### Resolve tenant
The middleware (`tenant.middleware.js#resolveTenant`) that decides
which tenant a request belongs to. Priority:
`X-Tenant-Id` header → JWT `tenantId` claim → subdomain (Phase 4+).

### Role
A collection of permissions. System roles are seeded and
immutable; custom roles are per-tenant.

### RPO / RTO
Recovery Point / Time Objective. How much data we can lose (RPO)
and how fast we recover (RTO) after an incident.

### Redis
An in-memory key/value store. We use it for cache, rate-limit
storage, Socket.IO cross-instance adapter, and BullMQ.

---

## S

### SCIM 2.0
System for Cross-domain Identity Management. User / group
provisioning from an IdP. Phase 3.

### Service
The business-logic layer. Owns transactions, cache invalidation,
queue calls, audit emission. Calls repositories; never talks to
Mongoose directly.

### Session
A record of an active login. Carries the refresh-token hash, IP,
UA, expiry, revocation timestamp.

### Slack
A workspace tool. Used for communication, not in the codebase.

### SLA
Service Level Agreement. A contractual promise on uptime,
response time, etc.

### SLI
Service Level Indicator. The metric behind an SLA.

### Soft delete
Marking a record as deleted (`deletedAt`) without removing it.
Records can be restored; the compliance cron hard-deletes past
retention.

### Socket.IO
A library that sits on top of WebSocket and adds rooms,
namespaces, ack-based events. We use it for realtime dashboards,
notifications and embed updates.

### Sprint
A short cycle (one to two weeks) where every commit is meant to
ship a user-visible feature. See `phases/sprint-N.md`.

### SSO
Single Sign-On. OAuth / OIDC / SAML. Phase 3.

### Stripe
A payment processor. We integrate in Phase 4 (per-tenant billing).

### Support Engineer
Holds the `support_admin` role. Impersonates tenants, performs
account recovery, reads cross-tenant audit. Mandatory reason;
daily cap.

### System role
A role seeded by code (`roles.seed.js`) and immutable. The six
system roles: `super_admin`, `platform_admin`, `support_admin`,
`tenant_owner`, `tenant_admin`, `tenant_member`.

---

## T

### TOTP
Time-based One-Time Password (RFC 6238). The MFA mechanism we
ship for `super_admin` in Sprint 1. Implemented via `otplib`.

### Tenant
The customer's organisation. One tenant = one isolated workspace.
Every tenant-owned record carries `tenantId`.

### Tenant Admin
Holds the `tenant_admin` role. Day-to-day operator within a
tenant. Cannot change billing.

### Tenant isolation
The three-layer defence against cross-tenant leakage:
`resolveTenant`, `tenantIsolation`, `tenantScope` plugin.

### Tenant Owner
Holds the `tenant_owner` role. Owns one tenant; can invite
Tenant Admins; can change billing.

### Tenant scope
The currently active tenant. `Model.useScope({ tenantId })`
activates it; the `tenantScope` plugin auto-injects the filter.

### Token revocation
Invalidating a refresh token (and its family) on logout, password
change, or replay detection. Session row is marked `revokedAt`.

### TTL (Time To Live)
How long a cache entry lives before expiring. The cache layer
returns `-1` for "no expiry" and `-2` for "key missing".

---

## U

### ULID
Universally Unique Lexicographically Sortable Identifier. Monotonic
ULIDs are strictly sortable within the same process. Preferred for
primary keys.

### UUID
Universally Unique Identifier. RFC 4122 v4. Random, not sortable.
Used when monotonic ordering does not matter.

---

## V

### Validator
A schema that validates the request body, params or query against
rules (type, length, pattern, range). See `src/validators/index.js`.

### View
A SQL-style term we do not use; in Mongoose we use `find`,
`findOne`, `findOneAndUpdate`.

---

## W

### Webhook
An inbound HTTP call from an external system. The platform signs
inbound webhooks with HMAC-SHA256; the caller sends a signature
header; we constant-time compare.

### Webhook signature
The `X-Signature: sha256=<hmac>` header the provider sends. We
verify it against the raw request body using the connector's
stored secret.

### Worker
A process that consumes from a queue. In our setup the worker runs
in the same process; BullMQ supports separate worker processes
when we need to scale.

---

## Y

### YAML
A configuration format. We use JSON in `.env.example`; YAML in
docker-compose.

---

## Summary

Every term in this codebase has a definition in this glossary. New
terms are added when they enter the codebase.

## Key Takeaways

- **Plain English.**
- **One definition per term.**

## Related Documents

- [`../README.md`](../README.md) — documentation homepage
- [`../TEMPLATE.md`](../TEMPLATE.md) — documentation standard

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)