# Development — Environment Setup

> **WHAT this is:** every environment variable documented.
> **WHY it exists:** the same code runs on Render, Railway, Docker,
> AWS ECS. The only difference is the env.
> **HOW to use it:** set the env you need; never edit source for
> deployment differences.
> **WHEN to update it:** when a new env var is added.
> **WHERE it lives:** `src/docs/development/environment-setup.md`.

---

## Purpose

> **WHAT this is:** every env var documented.
> **WHY it exists:** the only deployment difference is the env.
> **HOW to use it:** set the env you need.
> **WHEN to update it:** when a new env var is added.
> **WHERE it lives:** `src/docs/development/environment-setup.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Operator** | Has the deployment reference. |
| **New engineer** | Has the local setup reference. |

## Current Status

> **Status:** `Maintained`.
> **Sprint:** Always.

---

## Categories

| Group | Variables |
| --- | --- |
| Application | `NODE_ENV`, `PORT`, `APP_NAME`, `APP_VERSION`, `API_PREFIX` |
| MongoDB | `MONGODB_URI`, `MONGODB_*` (pool, retries) |
| CORS | `CORS_ORIGINS`, `CLIENT_URL` |
| Security | `JWT_SECRET`, `JWT_EXPIRES_IN`, `COOKIE_SECURE`, `TRUST_PROXY` |
| Rate limit | `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_STRICT_MAX` |
| Socket.IO | `SOCKET_CORS_ORIGIN`, `SOCKET_*` |
| Redis | `REDIS_URL` |
| Storage | `STORAGE_PROVIDER`, `STORAGE_BASE_DIR`, `S3_*` |
| Encryption | `ENCRYPTION_KEY`, `ENCRYPTION_ALGORITHM`, `ENCRYPTION_KEY_VERSION` |
| Mail | `MAIL_PROVIDER`, `SMTP_*`, `MAIL_FROM` |
| Scheduler | `SCHEDULER_ENABLED`, `SCHEDULER_TIMEZONE` |
| Background jobs | `JOB_*` (cron + enabled flags) |
| Logging | `LOG_LEVEL`, `LOG_REDACT` |
| Request body | `REQUEST_BODY_LIMIT` |
| Shutdown | `SHUTDOWN_TIMEOUT_MS` |

The canonical source is `.env.example` and `src/config/env.js`.

## Local Defaults

The defaults in `src/config/env.js` are safe for local development.
`JWT_SECRET` falls back to a dev-only insecure default; production
requires a real secret or the server refuses to start.

## Production Validation

In production (`NODE_ENV=production`):
- `JWT_SECRET` must not be the dev default.
- `MAIL_PASSWORD` is required when SMTP is configured.
- Other validations land as features grow.

## Best Practices

| Do | Why |
| --- | --- |
| **Use `.env.example`** as the source of truth. | A new env var must appear there. |
| **Never commit `.env`.** | Secrets belong in the platform secret manager. |
| **Document new env vars** in this file when you add them. | The CI guard reminds you. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Reading `process.env` from feature code.** | The CI guard blocks it. |

---

## Summary

Every env var is documented. Production validation is enforced.
The CI guard ensures no module reads `process.env` directly.

## Key Takeaways

- **One source of truth:** `.env.example`.
- **Production fail-fast.**
- **CI enforces `process.env` discipline.**

## Related Documents

- [`../../.env.example`](../../.env.example)
- [`../../config/env.js`](../../src/config/env.js)
- [`../../config/constants.js`](../../src/config/constants.js)
- [`deployment.md`](./deployment.md)

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)