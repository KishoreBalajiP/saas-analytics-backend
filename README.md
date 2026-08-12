# SaaS Analytics Platform — Backend

Production-grade foundation for a **multi-tenant SaaS analytics platform**.

> **Phase 2:** Sprints 0–6 complete — shared infrastructure, authentication for
> both portals, IAM + RBAC, Multi-Tenancy, Connector Platform (CSV + Webhook),
> Analytics Engine + Master Data, and Dashboards & Widgets. Sprint 7 — Governance —
> is planned. See `src/docs/STATUS.md` for the daily-read state and
> `CHANGELOG.md` for the roll-up.

---

## Tech Stack

| Concern        | Choice                                              |
| -------------- | --------------------------------------------------- |
| Runtime        | Node.js (LTS, ESM modules)                          |
| Framework      | Express 5                                           |
| Database       | MongoDB + Mongoose 8                                |
| Realtime       | Socket.IO 4 (with Redis adapter when `REDIS_URL`)   |
| Logging        | Pino (JSON in prod, pretty in dev) + Morgan         |
| Scheduler      | node-cron                                           |
| Security       | Helmet, CORS, express-rate-limit, cookie-parser     |
| JWT            | `jose` (HS256, modern, JWE-ready)                   |
| Password hash  | Argon2id (`argon2`)                                 |
| Email          | `nodemailer` (SMTP / noop)                          |
| Cache          | In-memory (default) or Redis (`ioredis`)            |
| Queue          | In-memory (default) or BullMQ on Redis              |
| Storage        | Local filesystem or S3 (`@aws-sdk/client-s3`)       |
| Encryption     | AES-256-GCM via `utils/encryption.js`               |
| Tooling        | Nodemon, dotenv, mongodb-memory-server              |

## Folder Structure

```text
src/
├── app.js                       # Express app assembly only
├── server.js                    # HTTP server, Socket.IO, DB, graceful shutdown
├── config/                      # all configuration (env, db, cors, logger, ...)
├── routes/                      # route mounting (health + future feature shells)
├── connectors/                  # connector framework: BaseConnector + registry
├── queues/                      # async queue contracts + in-memory + BullMQ
├── storage/                     # storage abstraction (local + S3)
├── cache/                       # cache abstraction (memory + Redis)
├── controllers/                 # HTTP layer (Phase 2 stubs)
├── services/                    # business logic + cache/storage/queue/email wrappers
├── repositories/                # data-access layer (Phase 2 stubs)
├── models/                      # Mongoose models + shared plugins
│   └── plugins/                 # tenantScope, softDelete, paginate, optimisticConcurrency, audit
├── validators/                  # request validation engine (dependency-free)
├── middleware/                  # express middleware
├── websocket/                   # Socket.IO bootstrap + events + rooms
├── jobs/                        # scheduler + background job stubs
├── utils/                       # cross-cutting helpers (jwt, password, encryption, id, ...)
├── templates/emails/            # future email templates
├── modules/                     # feature modules (iam, platform, governance, ...)
└── docs/                        # architecture documentation
tests/                           # node:test smoke/integration suite
  └── helpers/                   # mongo + factories + auth helpers
scripts/ci/                      # CI guardrail scripts
uploads/                         # reserved for future user uploads
logs/                            # reserved for future log files
```

## Quick Start

```bash
npm install
npm run dev        # starts with nodemon on http://localhost:8080
```

The server starts even without MongoDB or Redis (degraded mode) so the
foundation can be validated immediately. Health endpoint:

```bash
curl http://localhost:8080/api/v1/health
```

### Optional: MongoDB + Redis + full stack via Docker

```bash
cp .env.example .env
docker compose up --build
```

## Scripts

| Script                          | Purpose                                              |
| ------------------------------- | ---------------------------------------------------- |
| `npm start`                     | run in production (`node src/server.js`)             |
| `npm run dev`                   | run with nodemon (auto-restart on change)            |
| `npm test`                      | run the `node --test` suite (scrypt KDF, portable)             |
| `npm run test:argon2`           | run the suite against the real Argon2id KDF                    |
| `npm run ci:guards`             | run every CI guard in `scripts/ci/`                  |
| `npm run ci:check-stubs`        | verify no orphan `notImplementedStub`                |
| `npm run ci:check-routes`       | verify every route has auth or explicit exemption    |
| `npm run ci:check-models`       | verify every model uses a shared plugin              |
| `npm run ci:check-config`       | verify no module reads `process.env`                 |
| `npm run ci:check-readme-sync`  | verify module READMEs + STATUS.md are in place       |

## Configuration

All configuration flows through `src/config/env.js` and is exposed as a
frozen, validated object. **Modules never read `process.env` directly.**
Every variable is documented in `.env.example`.

New in Sprint 0:

- `STORAGE_PROVIDER`, `STORAGE_BASE_DIR`, `S3_*` - storage driver selection.
- `ENCRYPTION_KEY`, `ENCRYPTION_ALGORITHM`, `ENCRYPTION_KEY_VERSION` -
  separate from `JWT_SECRET` so rotation never invalidates tokens.

## Architecture Rules

1. **`app.js` only assembles Express.** It does not listen, connect to the
   database, or know about Socket.IO.
2. **`server.js` only boots the process.** HTTP server, Socket.IO init,
   database connect, scheduler init, graceful shutdown.
3. **Feature code lives in `src/modules/<feature>/`.** Controllers, services,
   repositories and models are cross-cutting infrastructure layers.
4. **Errors are centralised.** Throw/`next()` an `ApiError`; the global
   error middleware formats every response and never leaks stack traces
   in production.
5. **Everything is configurable via environment variables.** No deployment
   specific logic anywhere in the codebase.
6. **Fail closed.** Security middleware (auth/tenant) that is not implemented
   returns `501` rather than silently allowing traffic.
7. **Everything external is a connector.** CSV, Google Sheets, Webhooks,
   MongoDB, SQL and cloud data stores all implement the same `BaseConnector`
   contract (`src/connectors/`) and register in the registry.
8. **Infrastructure is abstracted.** Queues (`src/queues/`), storage
   (`src/storage/`), cache (`src/cache/`) and secret encryption
   (`utils/encryption.js`) have stable contracts; the concrete provider
   (memory/Redis, local/S3, BullMQ) is chosen by environment configuration,
   never hard-coded.
9. **Feature code only consumes service wrappers.** Controllers and services
   import `services/cache.service.js`, `services/queue.service.js`,
   `services/storage.service.js` and `services/email.service.js`; they
   never import `ioredis`, `bullmq`, `@aws-sdk/client-s3` or `nodemailer`.
10. **Tenant-owned models apply the standard plugin set.** See
    `src/models/plugins/README.md`.

## Sprint Status

Sprint 0 ships shared infrastructure; Sprints 1–3 ship authentication,
IAM/RBAC and multi-tenancy; Sprint 4 ships the Connector Platform;
Sprint 5 ships the Analytics Engine + Master Data; Sprint 6 ships
Dashboards & Widgets. See `src/docs/STATUS.md` for the daily-read state and
`CHANGELOG.md` for the detailed roll-up.

| Sprint | Scope                                                       | Status |
| ------ | ----------------------------------------------------------- | ------ |
| 0      | Shared utilities, cache/queue/storage/email, plugins, CI    | done   |
| 1      | Authentication (User, Admin, MFA)                           | done   |
| 2      | IAM (Admins, Tenants, Users, RBAC)                          | done   |
| 3      | Multi-Tenancy (tenant lifecycle, onboarding, auth gate, settings, feature flags) | done |
| 4      | Connector Platform (CSV + Webhook connectors, sync engine)   | done   |
| 5      | Analytics Engine + Master Data (query engine, history, exports, reference catalogue) | done |
| 6      | Dashboards & Widgets (authoring, lifecycle, sharing, execution, cache) | done |
| 7      | Governance: Audit + Access + Compliance                     | planned|
| 8      | Monitoring + Support                                        | planned|
| 9      | Reports + Embed                                             | planned|

## Deployment

The same code runs on Render, Railway, Docker, AWS ECS and (later) AWS Lambda
through a small adapter. Set environment variables per platform; there is no
platform-specific logic in the repository.

## License

Proprietary — internal to this organisation.
