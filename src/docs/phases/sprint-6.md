# Sprint 6 — Connectors (CSV + Webhook)

> **WHAT this is:** the plan for Sprint 6 — the first two concrete
> connectors (CSV and inbound Webhook).
> **WHY it exists:** the connector framework shipped in Phase 1.1;
> Sprint 6 ships the first two providers.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-6.md`.

---

## Purpose

> **WHAT this is:** the plan for Sprint 6 — CSV + Webhook connectors.
> **WHY it exists:** the framework shipped in Phase 1.1; Sprint 6
> ships the first providers.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-6.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 6 implementer** | Has the full plan. |
| **PM** | Has the connector scope to validate. |

## Current Status

> **Status:** `Planned`.
> **Sprint:** Sprint 6.
> **Owner:** Engineering team.

## Business Perspective

Most customers start with CSV exports from their operational tools.
Some have carrier / payment / SaaS APIs that can push via webhook.
Sprint 6 covers the two most common paths; Google Sheets and MongoDB
land in Phase 3.

## Technical Perspective

`CsvConnector` extends `BaseConnector`. `WebhookConnector` exposes
the inbound `/webhooks/<connector-id>` route with HMAC-SHA256
signature verification. Both use the connector queue (Sprint 0).

## Scope

- `CsvConnector` — file upload + parse + ingest. Stream-parse with
  backpressure.
- `WebhookConnector` — inbound route with raw body parsing + HMAC
  signature verification.
- `/connectors/*` CRUD (real).
- Connector queue consumer (real).

## Deliverables

### Concrete connectors
- `src/modules/connectors/csv/csv.connector.js`
- `src/modules/connectors/csv/csv.parser.js`
- `src/modules/connectors/webhook/webhook.connector.js`

### Shared
- `src/modules/connectors/shared/field-mapping.js`
- `src/modules/connectors/shared/sync-engine.js`
- `src/modules/connectors/shared/validators.js`
- `src/modules/connectors/shared/errors.js`

### Routes (real)
- `src/routes/connector.routes.js`
- `src/routes/webhook.routes.js`

### File upload
- `src/middleware/upload.middleware.js` — `multer` integration

### Consumer
- `src/queues/connector.queue.js#registerConsumer` — Sprint 6 stub
  becomes a real consumer that resolves the connector and runs the
  sync engine.

## Dependencies

- Sprint 0 (queue + storage) + Sprint 5 (settings for
  connector-level config).

## Testing

- Unit: CSV parser correctness (delimiter, header, encoding); HMAC
  signature verification (valid, invalid, missing); idempotency key
  dedupe.
- Integration: upload a CSV → enqueue → consumer ingests → rows in
  MongoDB. Webhook posts → signature verifies → consumer ingests.

## Risks

1. **CSV OOM on large files.** Stream-parse with backpressure;
  chunk into the queue per N rows.
2. **Webhook signature bypass.** Mount `express.raw` on the webhook
  route only; integration test with valid + invalid signatures.
3. **Connector secret encryption.** Connector `config` is encrypted
  at rest via `utils/encryption.js`.

## Definition of Done

- [ ] All deliverables merged.
- [ ] `POST /connectors` creates a CSV connector; upload works.
- [ ] `POST /webhooks/<id>` with valid signature → 200, ingested.
- [ ] `POST /webhooks/<id>` with invalid signature → 401.
- [ ] Idempotency: replaying the same CSV upload does not duplicate
      rows.
- [ ] 90 %+ test coverage.
- [ ] `STATUS.md` updated.

## Expected Outcome

Customers can ingest CSV uploads and accept inbound webhooks.

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

Sprint 6 ships CSV + Webhook connectors. After Sprint 6 customers
have two ingestion paths; the framework is proven.

## Key Takeaways

- **CSV must stream with backpressure.**
- **Webhooks use raw body + HMAC verification.**
- **Connector secrets are encrypted at rest.**

## Interview Preparation

### Common Questions

- "How do you verify a webhook signature?"
- "How do you handle large CSV uploads?"

### Sample Answers

- **"Webhook signature?"** — The provider sends
  `X-Signature: sha256=<hmac>`; we compute the HMAC over the *raw*
  request body using the connector's stored secret (encrypted at
  rest); constant-time compare. The route must mount `express.raw`,
  not `express.json`, because JSON parsing breaks the signature.

- **"Large CSV?"** — Stream-parse with `csv-parse`, backpressure on
  the consumer side. The HTTP request reads a stream from
  `multer`'s memory storage (Phase 3) or disk storage (deferred);
  the parser emits rows; we batch every 1 000 rows into the
  connector queue.

### Real-World Examples

- Acme Logistics uploads a 50 MB weekly shipments CSV. The
  connector parses it in chunks; the queue ingests 100 rows at a
  time; the dashboard reflects the new data within minutes.

### Common Mistakes

- JSON-parsing the webhook. It breaks the signature.
- Loading the whole CSV in memory. It OOMs.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-5.md`](./sprint-5.md) — previous
- [`sprint-7.md`](./sprint-7.md) — next

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Sprint planned:** Sprint 6
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)