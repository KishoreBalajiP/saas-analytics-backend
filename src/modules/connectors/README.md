# Module: Connectors

Sprint 4 implements the Connector Platform: the persistence layer (models +
repositories) and the first two providers — `csv` and `webhook`. The
provider-agnostic framework (`BaseConnector` + `ConnectorRegistry`) ships
with Phase 1.1; this module owns the feature layer and one folder per
concrete connector.

## Connectors

| Connector      | Source                                      | Scope |
| -------------- | ------------------------------------------- | ----- |
| `csv`          | uploaded CSV/XLSX files                     | parsing, field mapping, import (Sprint 4) |
| `webhook`      | incoming HTTP webhooks / streaming          | signature verification, buffering, ingest (Sprint 4) |
| `google-sheets`| Google Sheets documents                     | OAuth, ranges, scheduled sync (Phase 3) |
| `mongodb`      | customer-owned MongoDB Atlas databases      | URI, db/collection, preview, sync (Phase 3) |
| *future*       | PostgreSQL, MySQL, REST, GraphQL, Snowflake, BigQuery | - |

Each connector implements the `BaseConnector` lifecycle
(`connect / validate / preview / ingest / disconnect`) and registers itself in
the registry, so the HTTP layer stays provider-agnostic.

## Folder layout

```text
src/modules/connectors/
├── csv/            # CSV connector (parse + import)        — Sprint 4
├── webhook/        # webhook connector (ingest streams)     — Sprint 4
├── shared/         # field mapping, sync engine, common validation, errors
├── google-sheets/  # Google Sheets connector (sync)         — Phase 3
└── mongodb/        # customer MongoDB connector (preview + sync) — Phase 3
```

## HTTP surface

`src/routes/connector.routes.js` (mounted at `/api/v1/connectors`) exposes
provider-agnostic endpoints: create, list, validate, preview, trigger-sync,
delete. `src/routes/webhook.routes.js` exposes the inbound
`POST /api/v1/webhooks/:webhookToken` route (raw body + HMAC-SHA256).
Large syncs are enqueued via `src/queues/connector.queue.js` rather than run
inline.

## Already in place

- Models: `src/models/Connector.js`, `src/models/ConnectorRow.js`
  (tenant-scoped, `config` encrypted at rest via `utils/encryption.js`,
  idempotent `{ connectorId, sourceRowId }` rows).
- Repositories: `src/repositories/connector.repository.js`,
  `connectorRow.repository.js`.
- Framework: `src/connectors/{BaseConnector,ConnectorRegistry,index.js}`.

## Dependencies (reserved, not installed)

- CSV: `csv-parse` (already a dependency) + `multer` (already a dependency).
- Google Sheets: `googleapis` (Phase 3).
- Mongo customer databases: `mongodb` driver (Phase 3; transitive of mongoose).

Nothing extra is installed or wired yet — Sprint 4 wires the CSV and Webhook
providers and the sync engine.
