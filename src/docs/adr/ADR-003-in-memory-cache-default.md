# ADR-003: In-Memory Cache Default; Redis When `REDIS_URL` Is Set

**Status:** Accepted
**Date:** 2026-08-05

## Context

Tests and dev environments must run without external dependencies.
Production multi-instance deployments need a shared cache.

## Decision

The cache service (`services/cache.service.js`) auto-selects:

- In-memory transport when `REDIS_URL` is empty.
- Redis (`ioredis`) when `REDIS_URL` is set.

Both providers implement the same `CacheDriver` surface.

## Consequences

**Easier:**

- Local `npm run dev` works out of the box.
- Tests are fast and deterministic.
- Production multi-instance requires `REDIS_URL`.
- Provider switching is a one-line change.

**Harder:**

- Two providers to maintain (but the surface is small and stable).
- In-memory is single-instance; running tests in parallel would
  need process isolation (we do that).

## Implementation

- `src/cache/memory.js` and `src/cache/redis.js` are the providers.
- `src/services/cache.service.js` is the only public interface.
- Feature code never imports `ioredis`.

## Related

- [`../backend/cache.md`](../backend/cache.md)