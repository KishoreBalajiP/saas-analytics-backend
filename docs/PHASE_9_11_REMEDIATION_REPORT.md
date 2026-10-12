# Phase 9.11 — Remediation Report: Security Headers & Redis Production Readiness

## Summary

Two production-readiness fixes were implemented:

1. **Security headers** — Helmet security headers (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy) are confirmed set on all responses. A custom Content Security Policy suitable for a SaaS analytics platform is applied. HSTS is enabled only in production (HTTPS) and explicitly omitted in development. X-Powered-By is disabled.

2. **Redis production readiness** — The cache service correctly selects the Redis driver when `REDIS_URL` is configured and falls back to the in-memory driver when it is not. The production configuration validator rejects startup when `REDIS_URL` is missing. The Redis cache driver throws a clear error when constructed without a URL and surfaces connection errors to callers (not swallowed). Test-mode compatibility is preserved (test runner clears `REDIS_URL` and the memory driver is used).

## Changed Files

| File | Change |
|---|---|
| `backend/src/app.js` | Added HSTS conditional removal in development; added custom CSP middleware. |
| `backend/tests/security-headers.test.js` | **New** — 14 focused tests for security headers. |
| `backend/tests/cache/redis-production-readiness.test.js` | **New** — 8 focused tests for Redis behavior. |

## Security Header Verification

### Headers set on all responses (via `helmet()` + custom CSP middleware)

| Header | Value / Behavior | Test |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | `tests/security-headers.test.js:14` |
| `X-Frame-Options` | `SAMEORIGIN` (Helmet default) | `tests/security-headers.test.js:26` |
| `X-XSS-Protection` | Helmet default | `tests/security-headers.test.js:35` |
| `Referrer-Policy` | Helmet default | `tests/security-headers.test.js:44` |
| `Content-Security-Policy` | Custom policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self';` | `tests/security-headers.test.js:53-119` |
| `X-Powered-By` | Omitted (disabled via `app.disable('x-powered-by')`) | `tests/security-headers.test.js:122` |
| `Strict-Transport-Security` | Omitted when `NODE_ENV !== 'production'`; Helmet default in production | `tests/security-headers.test.js:129` |

### CSP rationale

The CSP is intentionally restrictive for a SaaS analytics platform:

- `default-src 'self'` — only same-origin resources by default.
- `script-src 'self'` — scripts must be served from the same origin (no inline scripts, no third-party CDNs).
- `style-src 'self' 'unsafe-inline'` — allows inline styles which are commonly required by React and component libraries.
- `img-src 'self' data:` — allows same-origin images and base64-encoded data URIs (used for inline icons, user avatars, etc.).
- `connect-src 'self'` — XHR/fetch/WebSocket only to the same origin.
- `font-src 'self'` — fonts from same origin only.
- `frame-src 'none'` — disallows all framing (clickjacking protection beyond X-Frame-Options).
- `object-src 'none'` — disables Flash/Java applets.
- `base-uri 'self'` — prevents `<base>` tag injection.

This policy is appropriate for an API backend that does not serve HTML. If the frontend is served from the same origin in a future deployment, the CSP can be relaxed to allow the frontend's scripts and styles.

### HSTS rationale

- Browsers only apply HSTS over HTTPS connections. Sending the header over HTTP in development is harmless (browsers ignore it) but unnecessary.
- In production, Helmet's default HSTS policy (`maxAge: 31536000`, `includeSubDomains: true`) is used.
- The test suite verifies that HSTS is omitted when `NODE_ENV=development`.

### CORS preserved

The existing CORS policy (via `cors(corsConfig)`) is unchanged. The CSP does not override or conflict with CORS — they address different concerns (browser cross-origin requests vs. browser same-origin policy enforcement).

## Redis Behavior

### Driver selection (cache service)

| `REDIS_URL` | `env.redis.enabled` | Selected driver |
|---|---|---|
| empty / unset | `false` | `memory` (in-process Map) |
| set (any value) | `true` | `redis` (ioredis-backed) |

### Connection failure handling

- **Missing URL**: `createRedisCache({ provider: 'redis', url: '' })` → `cache.get()` rejects with a clear error mentioning `url`.
- **Unreachable URL**: `createRedisCache({ url: 'redis://127.0.0.1:1' })` → `cache.get()` rejects with the underlying ioredis error (e.g., `ECONNREFUSED`).
- **Production validation**: `config/env.js` throws at startup if `NODE_ENV=production` and `REDIS_URL` is empty (existing behavior, preserved).

### Test-mode compatibility

The test runner (`scripts/ci/run-tests.js`) sets `REDIS_URL=''` before running tests. The cache service correctly falls back to the in-memory driver. All 528 tests pass with this behavior.

### Safe cleanup

- `cacheService.close()` is idempotent — safe to call multiple times.
- The Redis driver's `close()` method attempts `quit()` and falls back to `disconnect()` on error.
- The in-memory driver's `close()` clears the store.

## Actual Test Results

```
$ node scripts/ci/run-tests.js tests/security-headers.test.js tests/cache/redis-production-readiness.test.js
# tests 22
# pass 22
# fail 0

$ node scripts/ci/run-tests.js (full suite)
# tests 528
# pass 528
# fail 0
# cancelled 0
# skipped 0

$ node scripts/ci/run-all.js
check-stubs: OK
check-routes: OK
check-models: OK
check-config: OK
check-readme-sync: OK
ci:guards OK
```

## Required Production Configuration

| Variable | Required in production | Notes |
|---|---|---|
| `REDIS_URL` | ✅ | Full Redis connection string. The current `.env` example uses `rediss://...@host:port` (Upstash). The production validator rejects startup if this is missing or empty. |
| `NODE_ENV` | ✅ Must be `production` | The cache/queue drivers select Redis/BullMQ only when `env.redis.enabled` (i.e., `REDIS_URL` is set). The production config validator enforces that `REDIS_URL` is present when `NODE_ENV=production`. |

## Remaining Deployment Requirements (out of scope for 9.11)

The following items were intentionally NOT implemented in this task per the scope rules:

- **MongoDB automated backups** — deferred to a follow-up sprint.
- **Email delivery monitoring** — deferred to a follow-up sprint.
- **Staging verification** — the security headers and Redis driver selection were verified locally with `node --test` and the `run-tests.js` runner, but no live staging deployment was performed. Staging verification will need actual HTTP responses from a deployed environment and real Redis connectivity.

## Notes

- No commits, pushes, deploys, or modifications to production data were performed.
- No changes to MongoDB backup automation or email monitoring were made.
- The full backend test suite (528 tests) passes after both fixes.
- All CI guards pass (`check-stubs`, `check-routes`, `check-models`, `check-config`, `check-readme-sync`).
- The `check-config` guard was updated to use `env.app.isProduction` instead of `process.env.NODE_ENV` to comply with the project rule that `process.env` is only read in `src/config/`, `tests/`, and `scripts/ci/`.