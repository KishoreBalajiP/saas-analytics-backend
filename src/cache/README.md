# Cache - architecture

Caching abstraction. **Architecture only - no implementation in Phase 1.1.**

## Why cache

- Analytics query results, connector previews and dashboard payloads are
  expensive to recompute. A thin cache layer with a consistent interface lets
  the platform add caching per-feature without each feature coupling to a
  specific cache technology.

## The `CacheDriver` contract

Every provider returns a driver with the same method surface:

| Method                  | Responsibility                              |
| ----------------------- | ------------------------------------------- |
| `get(key)`              | read a value (null when missing/expired)    |
| `set(key, value, ttl?)` | write a value with optional TTL (seconds)   |
| `del(key)`              | remove a key (true when it existed)         |
| `ttl(key)`              | remaining TTL: >0, -1 no expiry, -2 missing |
| `increment(key, by)`    | atomic counter                              |
| `flushAll()`            | clear the cache (careful in shared Redis)   |
| `getOrSet(key, fn, ttl)`| memoize: run `fn` on miss, store, return    |

All keys are namespaced with a `keyPrefix` (default `saas:`) so one Redis
instance can serve multiple environments/tenants safely.

## Providers

| Provider | Factory           | Config (future)                          |
| -------- | ----------------- | ---------------------------------------- |
| memory   | `createMemoryCache` | `ttlDefault`, `keyPrefix`              |
| redis    | `createRedisCache`  | `url` (from `REDIS_URL`), `keyPrefix`  |

Selection via config only:

```js
import { createCache, CACHE_PROVIDERS } from '../cache/index.js';

const cache = createCache({ provider: CACHE_PROVIDERS.REDIS, url: process.env.REDIS_URL });
```

## Design rules

- Business logic calls `createCache(...)` once and passes the driver around;
  it never imports a Redis client directly.
- Memory cache is single-instance only. Multi-instance deployments MUST use
  the Redis provider (or the memory driver will serve stale data).
- Never cache tenant data without including `tenantId` in the key namespace.

## Status

Phase 1.1 ships the facade + provider stubs (fail closed). No Redis client is
installed. `REDIS_URL` remains reserved in `.env.example` / `config/env.js`.
