# SaaS Analytics Platform — Backend

Production-grade foundation for a **multi-tenant SaaS analytics platform**.

> **Phase 1 scope:** foundational architecture only. No business features
> (auth, tenants, dashboards, analytics, webhooks, emails, ...) are implemented
> yet. Phase 1.1 adds the **connector architecture** (a generic abstraction for
> CSV, Google Sheets, Webhooks, MongoDB, PostgreSQL, MySQL, REST, GraphQL,
> Snowflake, BigQuery) plus queue/storage/cache/encryption foundations - all
> architecture, no business logic. This repository is the backbone future
> teams build on.

---

## Tech Stack

| Concern        | Choice                                          |
| -------------- | ----------------------------------------------- |
| Runtime        | Node.js (LTS, ESM modules)                      |
| Framework      | Express 5                                       |
| Database       | MongoDB + Mongoose 8                            |
| Realtime       | Socket.IO 4                                     |
| Logging        | Pino (JSON in prod, pretty in dev) + Morgan     |
| Scheduler      | node-cron                                       |
| Security       | Helmet, CORS, express-rate-limit, cookie-parser |
| Tooling        | Nodemon, dotenv                                 |

## Folder Structure

```text
src/
├── app.js                  # Express app assembly only
├── server.js               # HTTP server, Socket.IO, DB, graceful shutdown
├── config/                 # all configuration (env, db, cors, logger, ...)
├── routes/                 # route mounting (health + future feature shells)
├── connectors/             # connector framework: BaseConnector + registry
├── queues/                 # async queue contracts (no transport installed yet)
├── storage/                # storage abstraction (local / s3, provider stubs)
├── cache/                  # cache abstraction (memory / redis, provider stubs)
├── controllers/            # HTTP layer (README with conventions)
├── services/               # business logic layer (README with conventions)
├── repositories/           # data-access layer (README with conventions)
├── models/                 # Mongoose models (none yet - README with conventions)
├── validators/             # request validation engine (dependency-free)
├── middleware/             # express middleware
├── websocket/              # Socket.IO bootstrap + events + rooms
├── jobs/                   # scheduler + background job stubs
├── utils/                  # cross-cutting helpers (ApiError, encryption, ...)
├── templates/emails/       # future email templates
├── modules/                # feature modules, incl. connectors/ (one per feature)
└── docs/                   # architecture documentation
tests/                      # smoke/integration tests (node:test)
uploads/                    # reserved for future user uploads
logs/                       # reserved for future log files
```

## Quick Start

```bash
npm install
npm run dev        # starts with nodemon on http://localhost:8080
```

The server starts even without MongoDB (degraded mode) so the foundation can
be validated immediately. Health endpoint:

```bash
curl http://localhost:8080/api/v1/health
```

### Optional: MongoDB + full stack via Docker

```bash
cp .env.example .env
docker compose up --build
```

## Scripts

| Script      | Purpose                                    |
| ----------- | ------------------------------------------ |
| `npm start` | run in production (`node src/server.js`)   |
| `npm run dev` | run with nodemon (auto-restart on change) |
| `npm test`  | run the `node:test` smoke suite            |

## Configuration

All configuration flows through `src/config/env.js` and is exposed as a frozen,
validated object. **Modules never read `process.env` directly.** Every variable
is documented in `.env.example`.

## Architecture Rules

1. **`app.js` only assembles Express.** It does not listen, connect to the
   database, or know about Socket.IO.
2. **`server.js` only boots the process.** HTTP server, Socket.IO init,
   database connect, scheduler init, graceful shutdown.
3. **Feature code lives in `src/modules/<feature>/`.** Controllers, services,
   repositories and models are cross-cutting infrastructure layers.
4. **Errors are centralised.** Throw/`next()` an `ApiError`; the global error
   middleware formats every response and never leaks stack traces in production.
5. **Everything is configurable via environment variables.** No deployment
   specific logic anywhere in the codebase.
6. **Fail closed.** Security middleware (auth/tenant) that is not implemented
   returns `501` rather than silently allowing traffic.
7. **Everything external is a connector.** CSV, Google Sheets, Webhooks,
   MongoDB, SQL and cloud data stores all implement the same `BaseConnector`
   contract (`src/connectors/`) and register in the registry. Business logic
   never depends on a vendor SDK. See `src/connectors/README.md`.
8. **Infrastructure is abstracted.** Queues (`src/queues/`), storage
   (`src/storage/`), cache (`src/cache/`) and secret encryption
   (`utils/encryption.js`) have stable contracts; the concrete provider
   (memory/Redis, local/S3, BullMQ) is chosen by environment configuration,
   never hard-coded.

## Deployment

The same code runs on Render, Railway, Docker, AWS ECS and (later) AWS Lambda
through a small adapter. Set environment variables per platform; there is no
platform-specific logic in the repository.

## License

Proprietary — internal to this organisation.
