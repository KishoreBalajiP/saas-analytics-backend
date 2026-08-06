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

## Implementation

- `src/middleware/idempotency.middleware.js` — the middleware.
- `src/utils/idempotency.js` — the deterministic key helpers.

## Related

- [`api-standards.md`](../development/api-standards.md)