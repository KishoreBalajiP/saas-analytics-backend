# Sprint 4 — Connector Platform (CSV + Webhook)

> **WHAT this is:** the plan for Sprint 4 — the complete Connector
> Platform: persisted, tenant-scoped connector CRUD, the CSV and inbound
> Webhook providers, the async sync engine and the inbound webhook
> surface.
> **WHY it exists:** the connector framework shipped in Phase 1.1; Sprint
> 4 ships the persistence layer and the first two concrete providers.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-4.md`.

> **Note (re-scope):** Sprint 4 was originally Master Data. Connectors
> are pulled forward to Sprint 4 (user prioritisation); Master Data
> moves to [Sprint 6](./sprint-6.md).

---

## Purpose

> **WHAT this is:** the plan for Sprint 4 — the Connector Platform.
> **WHY it exists:** customers ingest data via CSV uploads and inbound
> webhooks; Sprint 4 ships both paths on top of the Phase 1.1 framework.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-4.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 4 implementer** | Has the full plan. |
| **PM** | Has the connector scope to validate. |
| **Security reviewer** | Has the signature + encryption + idempotency rules. |

## Current Status

> **Status:** `In Progress`.
> **Sprint:** Sprint 4.
> **Owner:** Engineering team.

## Business Perspective

Most customers start with CSV exports from their operational tools.
Some have carrier / payment / SaaS APIs that can push via webhook.
Sprint 4 covers the two most common ingestion paths; Google Sheets and
MongoDB land in Phase 3.

## Technical Perspective

A persisted `Connector` (tenant-scoped, `config` encrypted at rest) is
the source of truth. `CsvConnector` extends `BaseConnector` and
stream-parses uploads; `WebhookConnector` exposes the inbound
`/webhooks/<webhookToken>` route with HMAC-SHA256 signature
verification. Both use the connector queue (Sprint 0); the sync engine
upserts into `ConnectorRow` on the `{ connectorId, sourceRowId }`
unique key so replays never duplicate rows.

## Scope

- `Connector` / `ConnectorRow` models (implemented Sprint 4) +
  repositories.
- `connector.service.js` — CRUD, config encryption at rest, validate /
  preview / trigger-sync / delete, row listing.
- `CsvConnector` — file upload + stream-parse + ingest with
  backpressure.
- `WebhookConnector` — inbound route with raw body parsing + HMAC
  signature verification.
- `/connectors/*` CRUD (real, tenant-authenticated).
- `/webhooks/<webhookToken>` inbound (public, signature-verified).
- Connector queue consumer (real): resolves the connector and runs the
  sync engine.
- `connectors.*` permission keys seeded for tenant roles.

## Deliverables

### Models (implemented)

- `src/models/Connector.js` — tenant-scoped, `config` = encrypted
  envelope, `webhookToken` (unique sparse) for webhook type, plain
  `fieldMapping`, `lastSyncedAt` / `lastError` / `errorCount`.
- `src/models/ConnectorRow.js` — ingested records, unique
  `{ connectorId, sourceRowId }` for idempotency.

### Repositories (implemented)

- `src/repositories/connector.repository.js` — list/findById/
  findByWebhookToken/create/update/bumpError/remove/countByType.
- `src/repositories/connectorRow.repository.js` — list/count/
  upsertRows/deleteForConnector.

### Concrete connectors

- `src/modules/connectors/csv/csv.connector.js`
- `src/modules/connectors/csv/csv.parser.js`
- `src/modules/connectors/webhook/webhook.connector.js`

### Shared

- `src/modules/connectors/shared/field-mapping.js`
- `src/modules/connectors/shared/sync-engine.js`
- `src/modules/connectors/shared/validators.js`
- `src/modules/connectors/shared/errors.js`

### Service + Controller + Validator

- `src/services/connector.service.js` — facade over repositories +
  registry.
- `src/controllers/connector.controller.js` — thin handlers.
- `src/controllers/webhook.controller.js` — inbound handler.
- `src/validators/connector.validator.js` — create/list/sync schemas.

### Routes (real)

- `src/routes/connector.routes.js` — `/api/v1/connectors/*`
  (`authenticate` + `resolveTenant` + `permission('connectors', ...)`).
- `src/routes/webhook.routes.js` — `POST /api/v1/webhooks/:webhookToken`
  with `express.raw` (signature-safe) + `webhookToken` lookup.

### File upload

- `src/middleware/upload.middleware.js` — `multer` integration (memory
  storage, size cap).

### Consumer

- `src/queues/connector.queue.js#registerConsumer` — placeholder becomes
  a real consumer that resolves the connector and runs the sync engine.

## Dependencies

- Sprint 0 (queue + storage + encryption), Sprint 1 (auth),
  Sprint 2 (RBAC + permission middleware), Sprint 3 (tenant isolation +
  settings). No dependency on master data (now Sprint 6).

## Testing

- Unit: CSV parser correctness (delimiter, header, encoding); HMAC
  signature verification (valid, invalid, missing); idempotency dedupe
  (`{ connectorId, sourceRowId }`); config encryption round-trip.
- Integration: create a CSV connector → upload → enqueue → consumer
  ingests → rows in MongoDB. Webhook posts → signature verifies →
  consumer ingests. Invalid signature → 401.

## Risks

1. **CSV OOM on large files.** Stream-parse with backpressure; batch
   into the queue per N rows.
2. **Webhook signature bypass.** Mount `express.raw` on the webhook
   route only; integration test with valid + invalid signatures.
3. **Connector secret encryption.** Connector `config` is encrypted at
   rest via `utils/encryption.js`; never logged or returned.

## Definition of Done

- [ ] All deliverables merged.
- [ ] `POST /connectors` creates a CSV connector; upload works.
- [ ] `POST /webhooks/<token>` with valid signature → 200, ingested.
- [ ] `POST /webhooks/<token>` with invalid signature → 401.
- [ ] Idempotency: replaying the same CSV upload does not duplicate
      rows.
- [ ] `npm test` green; `npm run ci:guards` green (5/5).
- [ ] `STATUS.md`, `CHANGELOG.md`, module READMEs + `AI_CONTEXT.md`
      updated.

## Expected Outcome

Customers can ingest CSV uploads and accept inbound webhooks, each
connector is a tenant-scoped, encrypted, admin-managed resource, and
the connector framework is proven with two real providers.

## Best Practices

| Do | Why |
| --- | --- |
| **Stream-parse CSV with backpressure.** | A 1 GB CSV must not OOM the process. |
| **Verify webhook signatures with constant-time compare.** | Timing attacks on signature checks are real. |
| **Encrypt connector `config` blobs at rest.** | The DB breach must not leak API keys. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Parsing JSON on the webhook route.** | Webhooks are signed against the raw bytes; JSON parsing breaks the signature. |

---

## Summary

Sprint 4 ships the Connector Platform: persisted, encrypted, tenant-
scoped connectors plus the CSV and Webhook providers. After Sprint 4
customers have two ingestion paths and the framework is proven.

## Key Takeaways

- **CSV must stream with backpressure.**
- **Webhooks use raw body + HMAC verification.**
- **Connector secrets are encrypted at rest.**
- **Idempotent ingestion** via the `{ connectorId, sourceRowId }` key.

## Interview Preparation

### Common Questions

- "How do you verify a webhook signature?"
- "How do you handle large CSV uploads?"

### Sample Answers

- **"Webhook signature?"** — The provider sends
  `X-Saas-Signature: sha256=<hmac>`; we compute the HMAC over the *raw*
  request body using the connector's (decrypted) `signingSecret`;
  constant-time compare. The route must mount `express.raw`, not
  `express.json`, because JSON parsing breaks the signature.

- **"Large CSV?"** — Stream-parse with `csv-parse`, backpressure on the
  consumer side. `multer` writes the upload to memory (size-capped); the
  parser emits rows; we batch every 1 000 rows into the connector queue.

### Real-World Examples

- Acme Logistics uploads a 50 MB weekly shipments CSV. The connector
  parses it in chunks; the queue ingests 100 rows at a time; the
  dashboard reflects the new data within minutes.

### Common Mistakes

- JSON-parsing the webhook. It breaks the signature.
- Loading the whole CSV in memory. It OOMs.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-3.md`](./sprint-3.md) — previous (Multi-Tenancy)
- [`sprint-5.md`](./sprint-5.md) — next
- [`../backend/connectors.md`](../backend/connectors.md) — deep dive

## Last Updated

- **Sprint:** Sprint 4 open (Connector Platform)
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-08
- **Author:** Engineering (Sprint 4)
