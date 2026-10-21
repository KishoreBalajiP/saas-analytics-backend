# ADR-008: Idempotency Middleware with Cached Outcomes

**Status:** Accepted
**Date:** 2026-08-05

## Context

Mobile clients retry. Without server-side idempotency, a retry of
the same request can create duplicate records, charge twice, or
write the same audit row twice.

## Decision

`middleware/idempotency.middleware.js` caches response outcomes in
the cache layer under a SHA-256 key derived from the header or body
fingerprint. Fail-closed: when the cache is unavailable the request
is rejected with 503 (configurable to fail-open for reads).

## Consequences

**Easier:**

- Mutations are safe to retry.
- Cache layer MUST be enabled for any route mounting the middleware.
- 64 KiB cap per stored outcome prevents cache fill by large
  payloads.
- Coalescing handles concurrent retries for the same key.

**Harder:**

- Concurrent in-flight retries share a single outcome.
- The header is optional; without one we fall back to a body
  fingerprint (suitable for same-process retries; not safe across
  tenants).

## Amendment (roadmap 1.12, 2026-10)

The middleware was never mounted until roadmap 1.12. It now runs inside
`authenticate` / `adminAuth` (`authenticateToken`) for every authenticated
POST / PUT / PATCH / DELETE that carries `X-Idempotency-Key`, and the
decision above changes as follows:

- The key comes from the header only (no body-fingerprint fallback) and is
  scoped by actor type + id, the token's tenant, the targeted `X-Tenant-Id`,
  method and path (`scopedKey`), so keys never collide across actors or
  tenants. Public routes (no verified actor) are not covered.
- Only 2xx string/JSON outcomes up to 64 KiB are stored, encrypted
  (AES-256-GCM), for `RETENTION_IDEMPOTENCY_DAYS` (default 1 day). Replays
  carry `X-Idempotent-Replay: true`.
- The same key with a different body is refused (422
  `IDEMPOTENCY_KEY_REUSED`); a duplicate in flight on another instance gets
  409 `IDEMPOTENCY_IN_PROGRESS` (short lock in the shared cache).
- The authenticated mount fails open (logged) when the cache is down, so a
  Redis incident cannot block every write; explicit mounts still fail
  closed by default.

## Implementation

- `src/middleware/idempotency.middleware.js` — the middleware.
- `src/utils/idempotency.js` — the deterministic key helpers.

## Related

- [`api-standards.md`](../development/api-standards.md)