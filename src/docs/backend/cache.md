# Backend — Cache Layer

> **WHAT this is:** the deep-dive on the cache layer (in-memory +
> Redis).
> **WHY it exists:** RBAC, settings, feature flags and idempotency
> all need a fast key/value store. Provider-agnostic so we can run
> in dev without Redis.
> **HOW to use it:** read *Architecture*; never import `ioredis` from
> feature code.
> **WHEN to update it:** as the cache layer evolves.
> **WHERE it lives:** `src/docs/backend/cache.md`.

---

## Purpose

> **WHAT this is:** the deep-dive on the cache layer.
> **WHY it exists:** RBAC, settings, feature flags and idempotency
> all need a fast key/value store.
> **HOW to use it:** read *Architecture*; never import `ioredis` from
> feature code.
> **WHEN to update it:** as the cache layer evolves.
> **WHERE it lives:** `src/docs/backend/cache.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Every Sprint implementer** | Has the cache contract. |
| **Operator** | Has the Redis selection rules. |

## Current Status

> **Status:** `Implemented (Sprint 0)`.
> **Sprint:** Sprint 0.
> **Owner:** Engineering team.

## Business Perspective

RBAC maps are read on every authenticated request. Settings are
read on every dashboard load. Idempotency outcomes are read on every
retry. The cache layer makes all of these fast.

## Technical Perspective

In-memory transport for dev/tests; Redis (`ioredis`) for production.
Same driver surface: `get`, `set`, `del`, `ttl`, `increment`,
`flushAll`, `getOrSet`, `close`. Selected by env (`REDIS_URL`).

The public service is `services/cache.service.js`. It applies the
`cache:` prefix so feature code never deals with prefixes.

## Architecture

```
                ┌──────────────────────┐
                │  Feature code         │
                └──────────┬───────────┘
                           │ services/cache.service.js
                           ▼
                ┌──────────────────────┐
                │  Cache facade         │
                │  get / set / getOrSet │
                └──────────┬───────────┘
                           │
            ┌──────────────┴──────────────┐
            │                             │
            ▼                             ▼
   ┌────────────────────┐       ┌────────────────────┐
   │  In-memory (Map)   │       │  ioredis            │
   │  (dev / tests)      │       │  (production)       │
   └────────────────────┘       └────────────────────┘
```

## Driver Surface

| Method | Returns |
| --- | --- |
| `get(key)` | `Promise<any \| null>` |
| `set(key, value, ttlSec?)` | `Promise<void>` |
| `del(key)` | `Promise<boolean>` |
| `ttl(key)` | `Promise<number>` |
| `increment(key, by)` | `Promise<number>` |
| `flushAll()` | `Promise<void>` |
| `getOrSet(key, fn, ttlSec)` | `Promise<any>` |
| `close()` | `Promise<void>` |

## Cache Keys (Sprint 1+ consumers)

| Key | TTL | Invalidated on |
| --- | --- | --- |
| `iam:rbac:<scope>` | 5 min | role or permission write |
| `settings:<scope>:<id>:<key>` | 10 min | setting write |
| `feature-flag:<key>` | 1 min | feature flag write |
| `idempotency:<hash>` | 24 h | TTL (no invalidation) |

## Real-world Examples

### Memoise a slow read

```js
import { getOrSet } from '../services/cache.service.js';

const result = await getOrSet(
  'dashboard:preview:' + dashboardId,
  async () => dashboardService.buildPreview(dashboardId),
  300, // 5 min
);
```

### Invalidate on write

```js
import { del } from '../services/cache.service.js';

await roleService.update(roleId, { permissions: [...] });
await del(`iam:rbac:${scope}`);
```

## Best Practices

| Do | Why |
| --- | --- |
| **Use the `cache:` prefix-free public service.** | Feature code never imports the driver. |
| **Invalidate on every write.** | Stale cache = wrong data. |
| **Use `getOrSet` for memoisation.** | Race-free; concurrent reads collapse to one DB hit. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Importing `ioredis` from feature code.** | Provider switching becomes a refactor. |
| **Caching tenant data without `tenantId` in the key.** | Cross-tenant leakage. |

---

## Summary

The cache layer has two transports (in-memory + Redis) and one
public service (`services/cache.service.js`). Feature code never
imports `ioredis`. Cache invalidation is mandatory on every write.

## Key Takeaways

- **Provider-agnostic.** In-memory in dev, Redis in prod.
- **Never cache tenant data without `tenantId` in the key.**
- **Invalidate on write.**

## Interview Preparation

### Common Questions

- "How do you keep the cache coherent?"
- "Why not use Redis directly?"

### Sample Answers

- **"Coherent?"** — TTL + invalidation on every write. Worst case
  after a write: TTL seconds. Acceptable; documented.
- **"Why not direct?"** — Provider switching is a one-file change;
  tests run without Redis; the `cache:` prefix lives in one place.

## Related Documents

- [`../../services/cache.service.js`](../../../src/services/cache.service.js) — facade
- [`../DECISIONS.md`](../DECISIONS.md) — ADR-003

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)