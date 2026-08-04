# Module: Connectors

Planned scope - NOT implemented in Phase 1.1.

This module is the **feature layer** for the connector ecosystem. It owns the
connector lifecycle exposed over HTTP and contains one folder per concrete
connector. The provider-agnostic framework (contract + registry) lives in
`src/connectors/`.

## Connectors planned

| Connector      | Source                                      | Scope |
| -------------- | ------------------------------------------- | ----- |
| `csv`          | uploaded CSV/XLSX files                     | parsing, field mapping, import |
| `google-sheets`| Google Sheets documents                     | OAuth, ranges, scheduled sync |
| `webhook`      | incoming HTTP webhooks / streaming          | signature verification, buffering |
| `mongodb`      | customer-owned MongoDB Atlas databases      | URI, db/collection, preview, sync |
| *future*       | PostgreSQL, MySQL, REST, GraphQL, Snowflake, BigQuery | - |

Each connector implements the `BaseConnector` lifecycle
(`connect / validate / preview / ingest / disconnect`) and registers itself in
the registry, so the HTTP layer stays provider-agnostic.

## Folder layout

```text
src/modules/connectors/
├── csv/            # CSV connector (parse + import)
├── google-sheets/  # Google Sheets connector (sync)
├── webhook/        # webhook connector (ingest streams)
├── mongodb/        # customer MongoDB connector (preview + sync)
└── shared/         # field mapping, sync engine, common validation
```

## HTTP surface

`src/routes/connector.routes.js` (mounted at `/connectors`) will expose
provider-agnostic endpoints: create, validate, preview, trigger-sync, delete.
Large syncs will be enqueued via `src/queues/connector.queue.js` rather than
run inline.

## Dependencies (reserved, not installed)

- CSV: `csv-parse` (or PapaParse) when implemented
- Google Sheets: `googleapis`
- Mongo customer databases: `mongodb` driver (already a transitive of mongoose)

Nothing here is installed or wired yet.
