# Backend — Connectors

> **WHAT this is:** the deep-dive on the connector framework and the
> concrete providers.
> **WHY it exists:** every data source plugs into one contract.
> Adding Sheets or MongoDB is one new class.
> **HOW to use it:** read *Architecture* before implementing a new
> connector.
> **WHEN to update it:** as the connector framework evolves or new
> providers ship.
> **WHERE it lives:** `src/docs/backend/connectors.md`.

---

## Purpose

> **WHAT this is:** the deep-dive on connectors.
> **WHY it exists:** every data source plugs into one contract.
> **HOW to use it:** read *Architecture* before adding a connector.
> **WHEN to update it:** as the framework or providers evolve.
> **WHERE it lives:** `src/docs/backend/connectors.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 6 implementer** | Has the framework deep-dive. |
| **Future connector author** | Has the lifecycle + registry contract. |

## Current Status

> **Status:** `Planned` — framework in place (Phase 1.1); Sprint 6
> ships the first two providers (CSV + Webhook).
> **Sprint:** Sprint 6 (first providers); Phase 3 (Sheets, MongoDB).
> **Owner:** Engineering team.

## Business Perspective

Most customers start with CSV exports. Some have carrier / payment
/ SaaS APIs that push via webhook. A few have production databases
the platform reads directly. All three paths plug into the same
connector framework.

## Technical Perspective

`BaseConnector` defines the lifecycle: `connect`, `validate`,
`preview`, `ingest`, `disconnect`. `ConnectorRegistry` enforces
uniqueness. Business code calls `createConnector(type, context)` and
never imports a vendor SDK. The connector queue (Sprint 0) handles
async work.

## Architecture

```
┌──────────────────────────┐
│  src/connectors/         │  framework
│  ├── BaseConnector.js    │  lifecycle
│  ├── ConnectorRegistry.js│  type → Class map
│  └── index.js            │  facade
└──────────────────────────┘

┌──────────────────────────┐
│  src/modules/            │  concrete providers
│  connectors/             │
│  ├── csv/                │  Sprint 6
│  ├── webhook/            │  Sprint 6
│  ├── google-sheets/      │  Phase 3
│  ├── mongodb/            │  Phase 3
│  └── shared/             │  field-mapping, sync-engine,
│                          │  validators, errors
└──────────────────────────┘

                  ▲
                  │ enqueue
                  ▼
┌──────────────────────────┐
│  queues/connector.queue  │  Sprint 0 driver
│  (BullMQ / in-memory)    │  Sprint 6 consumer
└──────────────────────────┘
```

## The Lifecycle

Every connector follows the same five-step lifecycle:

| Method | Returns | Purpose |
| --- | --- | --- |
| `connect(options)` | `Promise<void>` | Open driver / auth handshake; sets `this.connected = true` |
| `validate(options)` | `Promise<{valid, errors?}>` | Prove stored config works against the provider |
| `preview(options)` | `Promise<{fields, sample, meta}>` | Sample rows, list databases, etc. |
| `ingest(options)` | `Promise<{processed, skipped, error?}>` | Read source, push into pipeline |
| `disconnect()` | `Promise<void>` | Release resources; sets `this.connected = false` |

Plus: `testConnection()` is a convenience that calls
`connect → validate → disconnect`.

## Real-world Examples

### CSV connector (Sprint 6)

```js
import { CsvConnector } from './modules/connectors/csv/csv.connector.js';
import { registerConnector } from './connectors/index.js';

registerConnector(CsvConnector);

// later, in a service
import { createConnector } from './connectors/index.js';
const c = createConnector('csv', { id, config, tenantId });
await c.validate();
const preview = await c.preview({ limit: 10 });
```

### Webhook connector (Sprint 6)

```js
import { WebhookConnector } from './modules/connectors/webhook/webhook.connector.js';
registerConnector(WebhookConnector);

// the inbound route
router.post('/webhooks/:connectorId',
  express.raw({ type: '*/*' }),  // raw body for signature verification
  webhookController.handle);
```

The connector:

1. Reads the raw bytes.
2. Computes `HMAC-SHA256(secret, raw_body)`.
3. Constant-time compares with `X-Signature` header.
4. On match: enqueues a sync job via
   `services/queue.service.js#enqueueConnectorSync`.

## Best Practices

| Do | Why |
| --- | --- |
| **Stream-parse CSV with backpressure.** | A 1 GB CSV must not OOM. |
| **Verify webhook signatures with constant-time compare.** | Timing attacks on signature checks are real. |
| **Encrypt connector `config` blobs at rest** via `utils/encryption.js`. | The DB breach must not leak API keys. |
| **Idempotency keys for every job.** | Retries never duplicate work. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **JSON-parsing the webhook.** | It breaks the signature; the route must mount `express.raw`. |
| **Loading the whole CSV in memory.** | OOM. |
| **Importing a vendor SDK from business code.** | Defeats the abstraction. |
| **Skipping signature verification.** | Anyone with the URL can spam the queue. |

## Future Work

| Item | Phase |
| --- | --- |
| **Google Sheets connector** | Phase 3 |
| **MongoDB connector** (read-only) | Phase 3 |
| **Snowflake / BigQuery connectors** | Phase 4+ |
| **Connector marketplace** | Phase 7 |

---

## Summary

The connector framework is `BaseConnector` + `ConnectorRegistry`. The
first two providers (CSV + Webhook) ship in Sprint 6. Adding a new
provider is one new class registered at boot.

## Key Takeaways

- **One contract for every external system.**
- **Business code never imports a vendor SDK.**
- **Idempotency keys + signature verification + encryption at rest.**

## Interview Preparation

### Common Questions

- "How do you add a new data source?"
- "Why a framework, not one integration per source?"

### Sample Answers

- **"New data source?"** — Write one class extending `BaseConnector`,
  implement the five lifecycle methods, call `registerConnector(MyClass)`
  at boot. Business code calls `createConnector('mysource', context)`.
  No vendor SDK in feature code.

- **"Framework, not per-source?"** — Because per-source integration
  couples the platform to one vendor. With a framework, switching
  vendors is a one-file change; outages and deprecations are
  contained.

## Related Documents

- [`../phases/sprint-6.md`](../phases/sprint-6.md) — first providers
- [`../../connectors/README.md`](../../../src/connectors/README.md) — framework
- [`../../modules/connectors/`](../../../src/modules/connectors/) — concrete providers
- [`05-user-journey.md`](../05-user-journey.md) — Manager + Tenant Admin use connectors

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Sprint planned:** Sprint 6
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)