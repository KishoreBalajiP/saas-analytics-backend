# Module — Status

**Sprint:** 4 — Connector Platform
**Status:** 🕏 In Progress

**Implements:** persisted, tenant-scoped connector lifecycle + the CSV and
inbound Webhook providers: connector CRUD (config encrypted at rest via
`utils/encryption.js`), CSV upload + stream-parse ingest, webhook inbound
with HMAC-SHA256 signature verification, idempotent row ingestion through the
connector queue, and the `/connectors/*` + `/webhooks/*` surfaces.

**Real source files:**

- `src/models/Connector.js`, `src/models/ConnectorRow.js` — tenant-scoped
  schemas (config encrypted, `webhookToken` sparse-unique, `{connectorId,
  sourceRowId}` idempotent rows).
- `src/repositories/connector.repository.js`, `connectorRow.repository.js` —
  tenant-scoped data access; `config` stays an encrypted envelope.
- `src/connectors/` — framework (`BaseConnector`, `ConnectorRegistry`,
  `index.js` facade) from Phase 1.1; Sprint 4 adds the `csv` and
  `webhook` providers.
- `src/modules/connectors/{csv,webhook,shared}/` — connector
  implementations + the shared sync engine.
- `src/queues/connector.queue.js` — real consumer (resolves a connector,
  runs the sync engine, upserts rows).

**Depends on:** Sprints 0–3 (bootstrap, auth, IAM/RBAC, multi-tenancy).
Master Data (now Sprint 6) is **not** required.
