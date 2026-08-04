# Architecture

## System Diagram

```
                ┌────────────────────────┐
                │       Clients          │
                │  (web, mobile, SDK)    │
                └────────────┬───────────┘
                             │ HTTP / WebSocket
                             ▼
        ┌────────────────────────────────────────┐
        │  Express (app.js)                      │
        │   ├── requestId  → req.id, req.log     │
        │   ├── helmet / cors / compression      │
        │   ├── body parsers                     │
        │   ├── morgan → pino                    │
        │   └── apiLimiter                       │
        └─────────────────┬──────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────────────┐
        │  Routes (src/routes/index.js)          │
        │   ├── /health      (live)              │
        │   ├── /auth/*      (Sprint 1)          │
        │   ├── /admin-auth/* (Sprint 1)         │
        │   ├── /tenants/*   (Sprint 2)          │
        │   ├── /roles/*     (Sprint 3)          │
        │   ├── /permissions/* (Sprint 3)        │
        │   ├── /connectors/* (Sprint 6)         │
        │   ├── /dashboards/* (Sprint 9)         │
        │   ├── /reports/*   (Sprint 9)          │
        │   └── /audit-logs/*, /access-logs/*,  │
        │       /compliance/*  (Sprint 7)       │
        └─────────────────┬──────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────────────┐
        │  Middleware (per-route)                 │
        │   ├── authenticate / adminAuth          │
        │   ├── resolveTenant                    │
        │   ├── tenantIsolation                  │
        │   ├── rbac / permission                │
        │   ├── idempotency                      │
        │   ├── validateRequest                  │
        │   └── audit / accessLog                │
        └─────────────────┬──────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────────────┐
        │  Controllers (thin)                    │
        └─────────────────┬──────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────────────┐
        │  Services                              │
        │   ├── auth / iam / rbac / etc.          │
        │   └── cache / queue / storage / email  │
        │       (the only public infrastructure) │
        └─────────────────┬──────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────────────�
        │  Repositories                          │
        └─────────────────┬──────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────────────┐
        │  Mongoose Models + Plugins              │
        │   ├── tenantScope                      │
        │   ├── softDelete                       │
        │   ├── paginate                         │
        │   ├── optimisticConcurrency           │
        │   └── audit (event emitter)            │
        └─────────────────┬──────────────────────┘
                          │
                          ▼
                ┌─────────────────────┐
                │     MongoDB         │
                └─────────────────────┘

        Side channels:
        ┌──────────────────┐  ┌──────────────────┐
        │  Cache (Redis)   │  │  Queue (BullMQ)  │
        │  via cache.svc   │  │  via queue.svc   │
        └──────────────────┘  └──────────────────┘

        ┌──────────────────┐  ┌──────────────────┐
        │  Storage (S3)    │  │  Email (SMTP)    │
        │  via storage.svc │  │  via email.svc   │
        └──────────────────┘  └──────────────────┘
```

## Request Lifecycle

1. **requestId** attaches `req.id` (UUID) and `req.log` (pino child).
2. **helmet / cors / compression** apply standard security headers.
3. **body parsers** validate JSON + form bodies up to `REQUEST_BODY_LIMIT`.
4. **morgan** logs every request through pino with the request id.
5. **apiLimiter** throttles traffic per IP.
6. **Routes** dispatch by path. Each route mounts its own middleware chain:
   - `authenticate` (or `adminAuth`) → attaches `req.actor`.
   - `resolveTenant` → attaches `req.tenant`.
   - `tenantIsolation` → rejects cross-tenant access.
   - `rbac` / `permission` / `modulePermission` → role + permission checks
     using the cache (`iam:rbac:<scope>`).
   - `idempotency` → replay-safe POSTs.
   - `validateRequest` → input validation.
   - `audit` / `accessLog` → governance capture.
7. **Controller** is thin: parses input, calls one service, returns the
   envelope.
8. **Service** owns business logic; throws `ApiError.*`; calls
   `cache/queue/storage/email` services for infrastructure.
9. **Repository** owns Mongoose queries; never throws HTTP errors.
10. **Model** owns schema + hooks; plugins apply tenant scoping,
    soft delete, pagination, optimistic concurrency, audit events.
11. **errorHandler** formats every failure into the standard envelope.

## Module Dependencies

```
controllers ──▶ services ──▶ repositories ──▶ models
                  │
                  ├──▶ services/cache.service.js ──▶ cache/{memory,redis}.js
                  ├──▶ services/queue.service.js ──▶ queues/index.js ──▶ BullMQ | memory
                  ├──▶ services/storage.service.js ──▶ storage/{local,s3}.js
                  ├──▶ services/email.service.js ──▶ nodemailer
                  └──▶ services/encryption ──▶ utils/encryption.js

middleware   ──▶ services/cache.service.js (idempotency)
models/*     ──▶ models/plugins/*
jobs/*       ──▶ services/queue.service.js
```

The dependency direction is strict: no layer imports a layer above it.

## Data Flow Principles

- **Tenant isolation** is enforced in three places: the `resolveTenant`
  middleware (resolves the active tenant), the `tenantIsolation` middleware
  (rejects mismatches) and the `tenantScope` plugin (auto-injects
  `tenantId` on every query).
- **Permissions** are checked before any mutation; `rbac`/`permission`
  middleware reads from `iam:rbac:<scope>` and the cache is invalidated on
  every role/permission write.
- **Audit** is captured at the middleware boundary so every mutation is
  recorded even if the controller crashes mid-request.
- **Idempotency** is the contract between an HTTP caller and the API: the
  middleware caches the response so retries never re-run the handler.

## Configuration Discipline

- `process.env` is read **only** in `src/config/env.js`. The CI guard
  `npm run ci:check-config` enforces this.
- All secrets (`JWT_SECRET`, `ENCRYPTION_KEY`, `S3_*`, `SMTP_PASSWORD`,
  `REDIS_URL`) live in `.env` and are validated up-front in production.
- The application boots in **degraded mode** when MongoDB or Redis are
  unreachable so health endpoints and admin escape hatches stay available.

## Deployment Discipline

- The same code runs on Render, Railway, Docker, AWS ECS and (later) AWS
  Lambda. Selection is config-only - no platform-specific logic in source.
- Multi-instance scaling requires Redis (`REDIS_URL`) to be set: cache
  becomes shared, BullMQ replaces the in-memory queue, and the Socket.IO
  Redis adapter enables cross-instance broadcasts.
