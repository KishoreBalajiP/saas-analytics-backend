# Architecture Documentation

Index of architecture and decision records for the backend.

## Documents (to be created as features land)

- `ARCHITECTURE.md` - system diagram, request lifecycle, data flow
- `connectors.md` - connector lifecycle, registry, adding a new provider
- `errors.md` - error envelope contract and error code catalogue
- `auth.md` - token/cookie strategy once auth lands
- `multi-tenancy.md` - tenant resolution + data isolation strategy
- `realtime.md` - Socket.IO room model and event catalogue
- `deployments.md` - runbook for each target platform (env-only changes)

## Current foundation summary

- `src/app.js` - Express assembly (middleware order, API mount).
- `src/server.js` - boot + graceful shutdown (HTTP, Socket.IO, DB, scheduler).
- `src/config/` - all configuration; modules never read `process.env`.
- `src/middleware/error.middleware.js` - single error envelope for all APIs.
- `src/websocket/` - Socket.IO bootstrap + event registry + room helpers.
- `src/jobs/` - node-cron scheduler + job stubs (all disabled by default).
- `src/connectors/` - connector framework (BaseConnector contract + registry);
  concrete connectors under `src/modules/connectors/`.
- `src/queues/` `src/storage/` `src/cache/` `utils/encryption.js` - async /
  storage / cache / secret-encryption contracts (fail-closed stubs, no
  implementations, no new dependencies).

## Conventions (enforced by review)

1. Feature code -> `src/modules/<feature>/`, shared code -> layer folders.
2. Errors thrown as `ApiError`, responses sent with `ApiResponse`.
3. Async handlers wrapped in `asyncHandler`.
4. New env vars must be added to `.env.example` and `config/env.js`.
5. No platform-specific deployment logic in source.
