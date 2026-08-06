# Development — Deployment

> **WHAT this is:** the deployment runbook — Render, Railway,
> Docker, AWS ECS.
> **WHY it exists:** the same code runs everywhere; the runbook is
> the difference between "works on my machine" and "works in
> production".
> **HOW to use it:** follow the runbook for your platform.
> **WHEN to update it:** when a new platform is supported.
> **WHERE it lives:** `src/docs/development/deployment.md`.

---

## Purpose

> **WHAT this is:** the deployment runbook.
> **WHY it exists:** the same code runs everywhere.
> **HOW to use it:** follow the runbook for your platform.
> **WHEN to update it:** when a new platform is supported.
> **WHERE it lives:** `src/docs/development/deployment.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Operator** | Has the deployment reference. |
| **Tech lead** | Has the platform matrix. |

## Current Status

> **Status:** `Maintained`.
> **Sprint:** Always.

---

## Platform Matrix

| Platform | Status | Notes |
| --- | --- | --- |
| **Docker (local)** | ✅ Supported | `docker compose up --build` |
| **Render** | ✅ Supported | Web service + managed MongoDB + managed Redis + S3 |
| **Railway** | ✅ Supported | Service + MongoDB plugin + Redis plugin |
| **AWS ECS** | ✅ Supported | Fargate + DocumentDB + ElastiCache + S3 |
| **AWS Lambda** | 🕓 Planned (Phase 4+) | Adapter shim for `server.js` lifecycle |
| **Fly.io** | 🕓 Planned | Same as Docker |

## The Same Code

Every platform runs the same `src/server.js`. The only difference
is the env. There is no platform-specific logic in source.

## Process Lifecycle

1. `server.js` creates the HTTP server and the Socket.IO instance.
2. `server.listen(port)` binds; the readiness probe (`/health`) is
   the very first thing that responds.
3. `connectDatabase()` runs in the background; on failure the
   server stays in **degraded mode** (health endpoint reports
   `db: 'disconnected'`).
4. `initScheduler()` runs when the DB is up.
5. SIGINT / SIGTERM triggers graceful shutdown with a 10-second
   hard timeout.

## Health Endpoint

- Public.
- Returns `{ status: 'ok', db: 'connected' | 'disconnected' }`.
- Rate-limit-exempt.
- Used by every platform's readiness probe.

## Graceful Shutdown

The server:
1. Stops accepting new connections.
2. Drains in-flight requests.
3. Closes Socket.IO.
4. Stops the scheduler.
5. Disconnects from MongoDB.
6. Exits with code 0 (success) or 1 (failure).

Hard timeout: 10 s (`SHUTDOWN_TIMEOUT_MS`).

## Required Env per Platform

| Variable | Render | Railway | ECS | Docker (local) |
| --- | --- | --- | --- | --- |
| `MONGODB_URI` | internal | plugin | DocumentDB endpoint | `mongodb://mongo:27017/saas_analytics` |
| `REDIS_URL` | internal | plugin | ElastiCache endpoint | (empty → in-memory) |
| `STORAGE_PROVIDER` | `s3` | `s3` | `s3` | `local` |
| `S3_BUCKET` / `S3_REGION` / `S3_*` | required | required | required | n/a |
| `SMTP_*` | required | required | required | (empty → noop) |
| `JWT_SECRET` | secret | secret | secret | dev default OK |

## Best Practices

| Do | Why |
| --- | --- |
| **Use the same code; differ only by env.** | The platform abstraction is the contract. |
| **Health-check on `/health`** in the platform config. | Platform-level readiness probes. |
| **Set `SHUTDOWN_TIMEOUT_MS`** below the platform's grace period. | Avoid double-kills. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Edit source for deployment differences.** | Use env. |
| **Skip the readiness probe.** | The platform kills the pod before it is ready. |

---

## Summary

The same code runs on every platform. The runbook is the only
difference. Health endpoint + graceful shutdown + env-only
configuration.

## Key Takeaways

- **Same code, different env.**
- **Readiness probe on `/health`.**
- **Graceful shutdown with 10 s hard timeout.**

## Interview Preparation

### Common Questions

- "How do you deploy to multiple platforms?"

### Sample Answers

- **"Deploy?"** — Same code; different env. Render, Railway, ECS
  and local Docker all run `node src/server.js`. Readiness probe
  on `/health`; graceful shutdown with 10 s hard timeout.

## Related Documents

- [`environment-setup.md`](./environment-setup.md)
- [`../../Dockerfile`](../../Dockerfile)
- [`../../docker-compose.yml`](../../docker-compose.yml)

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)