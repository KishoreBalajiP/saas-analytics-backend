# Development — API Standards

> **WHAT this is:** the wire-format and behaviour every API endpoint
> must follow.
> **WHY it exists:** clients consume the API; a stable contract is
> the contract.
> **HOW to use it:** read before opening an endpoint; cross-check
> before merging.
> **WHEN to update it:** when a wire-format rule changes.
> **WHERE it lives:** `src/docs/development/api-standards.md`.

---

## Purpose

> **WHAT this is:** the wire-format standards.
> **WHY it exists:** clients consume the API; stability is the
> contract.
> **HOW to use it:** read before opening an endpoint.
> **WHEN to update it:** when a wire-format rule changes.
> **WHERE it lives:** `src/docs/development/api-standards.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Backend engineer** | Has the contract. |
| **Frontend engineer** | Has the consumer view. |

## Current Status

> **Status:** `Maintained`.
> **Sprint:** Always.
> **Owner:** Founding architect.

---

## Versioning

- Prefix every endpoint with `/api/v1/`.
- Breaking changes bump to `/api/v2/`.
- Never remove a v1 endpoint; mark it deprecated and route to v2.

## Success Envelope

```json
{
  "success": true,
  "statusCode": 200,
  "message": "User created",
  "data": { "id": "usr_01H...", "email": "a@b.c" },
  "meta": { "page": 1, "limit": 20, "totalDocs": 42 },
  "timestamp": "2026-08-05T10:00:00.000Z"
}
```

- `success` — boolean.
- `statusCode` — HTTP status, echoed in the response.
- `message` — human-readable.
- `data` — payload or null.
- `meta` — pagination + links when relevant.
- `timestamp` — ISO 8601 UTC.

## Error Envelope

```json
{
  "success": false,
  "statusCode": 422,
  "message": "Validation failed",
  "code": "VALIDATION_FAILED",
  "errors": [
    { "field": "email", "message": "must be a valid email address" }
  ],
  "timestamp": "2026-08-05T10:00:00.000Z"
}
```

Stack traces are only included outside production.

## Pagination

- Use `mongoose-paginate-v2` (Sprint 0 plugin).
- Default `limit: 20`, max `limit: 100`.
- Response includes `meta.totalDocs`, `meta.totalPages`,
  `meta.page`, `meta.limit`.

```json
"meta": {
  "totalDocs": 142,
  "limit": 20,
  "page": 2,
  "totalPages": 8,
  "hasNextPage": true,
  "hasPrevPage": true
}
```

## Idempotency

- `POST` endpoints accept an `X-Idempotency-Key` header.
- The first call runs the handler; subsequent calls with the same
  key replay the cached response.
- `X-Idempotent-Replay: true` on the replay.
- Fail-closed when the cache is unavailable.

## Authentication

- Access token: `Authorization: Bearer <jwt>`.
- Refresh token: HttpOnly + Secure + SameSite=Lax cookie.
- Both audiences: `user` / `admin`.

## Rate Limiting

- Global: 300 requests / 15 min / IP.
- Auth: 20 requests / 15 min / IP (`strictLimiter`).
- 429 response on overflow with `Retry-After` header.

## Headers

- `X-Request-Id` round-trips for traceability.
- `X-Tenant-Id` is a hint; the JWT claim is the truth.
- `X-Idempotency-Key` for safe retries.
- `X-Idempotent-Replay: true` on cached responses.
- `Content-Type: application/json; charset=utf-8`.

## Best Practices

| Do | Why |
| --- | --- |
| **Use the standard envelope.** | Clients build once. |
| **Mount `validateRequest(schema)`** on every input. | Bad input is 422, not 500. |
| **Mount `idempotency`** on every POST. | Retries are safe. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Returning raw errors.** | The global handler is the source of truth. |
| **Returning 200 with a placeholder body.** | Frontend cannot tell the difference. |

---

## Summary

The API standard is the envelope, the error envelope, pagination,
idempotency, auth, rate limiting, headers. CI enforces the
load-bearing rules.

## Key Takeaways

- **One envelope shape.**
- **Idempotency on every POST.**
- **`validateRequest` on every input.**

## Interview Preparation

### Common Questions

- "How do you design a stable API?"
- "What is in your error envelope?"

### Sample Answers

- **"Stable API?"** — Versioned prefix (`/api/v1/`); one success
  envelope; one error envelope; idempotency on every POST; JWT
  auth; rate limiting; CI guard enforces fail-closed stubs.

- **"Error envelope?"** — `{ success, statusCode, message, code,
  errors?, timestamp }`. Stack traces only outside production.

## Related Documents

- [`coding-standards.md`](./coding-standards.md)
- [`../backend/errors.md`](../../docs/errors.md) — error contract
- [`../../utils/ApiError.js`](../../src/utils/ApiError.js)
- [`../../utils/ApiResponse.js`](../../src/utils/ApiResponse.js)

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)