# MongoDB Connector Module — Status

**Sprint:** 9 (External API + API Keys + Embed + Product Delivery)
**Status:** ✅ Implemented
**Implements:** external MongoDB source pull-sync connector

## Real Source Files

- `src/modules/connectors/mongodb/mongodb.connector.js` — MongoDBConnector class
- `src/modules/connectors/mongodb/index.js` — provider registration

## Configuration

Plain (encrypted at rest):
- `uri` — MongoDB connection string (`mongodb://` or `mongodb+srv://`)
- `database` — target database name
- `collection` — target collection name
- `filter` (optional) — MongoDB query filter object

## Config Validation (shared/validators.js)

- `uri`: required, valid MongoDB URI (mongodb:// or mongodb+srv://)
- `database`: required, non-empty string
- `collection`: required, non-empty string
- `filter`: optional, plain object

## Capabilities

- `validate` — validates config via shared validators
- `ingest` — connects to external MongoDB, streams cursor, yields documents

## Connector Service Integration

- `redactConfig(type, config)` — returns `{ host, database, collection, filterConfigured, hasCredentials }` (no secrets)
- `syncMongoDB({ tenantId, connectorId })` — enqueues pull-sync job (no file upload)
- `processSyncMessage` — for `mongodb` type, calls `instance.ingest()` (async iterable, no buffer)

## Security

- Credentials stay encrypted at rest (connector config envelope).
- `redactConfig` never exposes URI credentials.
- Connect timeouts from env (`connectors.mongodb.connectTimeoutMs`, `serverSelectionTimeoutMs`).
- Max documents per sync capped (`connectors.mongodb.maxDocsPerSync`, default 100k).
- Connection uses short-lived `MongoClient` (connected in `ingest()`, disconnected after).

## Tests

- `tests/connectors/mongodb.connector.test.js` — config validation, ingest cursor streaming, credential redaction.

## Sprint 9 Notes

Added alongside XLSX connector to complete the connector platform.
See `src/docs/phases/sprint-9.md` for the full delivery record.

## Last Updated

- **Sprint:** Sprint 9 close
- **Date:** 2026-08-16
- **Author:** Engineering