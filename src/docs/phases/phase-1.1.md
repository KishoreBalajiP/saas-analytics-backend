# Phase 1.1 — Connector & Infrastructure Architecture

> **WHAT this is:** the record of Phase 1.1 — the connector framework
> and the fail-closed infrastructure stubs that followed Phase 1.
> **WHY it exists:** every later connector (CSV, Webhook, Sheets,
> MongoDB) plugs into this framework without refactoring business
> code.
> **HOW to use it:** read *Deliverables* and *Completion Criterion*.
> **WHEN to update it:** only if a Phase 1.1 file changes.
> **WHERE it lives:** `src/docs/phases/phase-1.1.md`.

---

## Purpose

> **WHAT this is:** the record of Phase 1.1 — the connector framework
> and the fail-closed infrastructure stubs.
> **WHY it exists:** every later connector plugs into this framework
> without refactoring business code.
> **HOW to use it:** read *Deliverables* and *Completion Criterion*.
> **WHEN to update it:** only if a Phase 1.1 file changes.
> **WHERE it lives:** `src/docs/phases/phase-1.1.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **New backend engineer** | Knows how to add a new connector without touching other code. |
| **Sprint 6 implementer** | Has a stable framework to plug into. |
| **Interview candidate** | Has a single doc describing the connector pattern. |

## Current Status

> **Status:** `Completed`.
> **Sprint:** Completed before Sprint 0; the framework is in place but
> no concrete connector is registered yet.
> **Owner:** Founding architect.

## Business Perspective

Every data source the platform ingests (CSV, Google Sheets,
Webhooks, MongoDB, REST, GraphQL, Snowflake, BigQuery) plugs into one
contract. Vendors come and go; the contract is permanent.

## Technical Perspective

`BaseConnector` defines the lifecycle. `ConnectorRegistry` validates
subclasses and refuses duplicates. Business code never imports a
vendor SDK; it only sees `createConnector('csv', context)`. The
storage, cache and queue facades are also stable — provider-agnostic,
provider-selectable via env, fail-closed until a transport is chosen.

## Architecture

```
src/connectors/
├── BaseConnector.js          # lifecycle: connect / validate / preview / ingest / disconnect
├── ConnectorRegistry.js      # type → Class map; throws on duplicate / unknown
├── index.js                  # public facade
└── README.md
```

```
src/cache/        ← CACHE_PROVIDERS = { MEMORY, REDIS }   (provider stubs)
src/storage/      ← STORAGE_PROVIDERS = { LOCAL, S3 }     (provider stubs)
src/queues/       ← queue method surface contract          (provider stubs)
```

## Deliverables

| Area | Files | Purpose |
| --- | --- | --- |
| Connector framework | `src/connectors/BaseConnector.js`, `src/connectors/ConnectorRegistry.js`, `src/connectors/index.js`, `src/connectors/README.md` | Lifecycle + registry + facade |
| Cache facade | `src/cache/index.js`, `src/cache/memory.js`, `src/cache/redis.js`, `src/cache/README.md` | `CACHE_PROVIDERS`, fail-closed stubs |
| Storage facade | `src/storage/index.js`, `src/storage/localStorage.js`, `src/storage/s3Storage.js`, `src/storage/README.md` | `STORAGE_PROVIDERS`, fail-closed stubs |
| Queue facade | `src/queues/index.js`, `src/queues/constants.js`, `src/queues/{connector,email,analytics}.queue.js`, `src/queues/README.md` | `QUEUE_METHODS`, fail-closed stubs |

## Dependencies

Phase 1.

## Completion Criterion

- `BaseConnector` is unit-tested.
- A test connector registers at boot without error.
- Every facade returns a handle with the documented method surface.
- Every stub method fails closed with a descriptive error.

## Expected Outcome

When Sprint 6 starts, the engineer writes
`src/modules/connectors/csv/csv.connector.js` extending
`BaseConnector`, calls `registerConnector(CsvConnector)` at boot, and
ships a working connector without touching any other file.

## Real-world Examples

- Phase 2 / Sprint 6 ships the CSV connector and the Webhook
  connector. Both plug into `BaseConnector` directly.
- A future engineer adds a MongoDB connector (Phase 3) by writing
  one file. No business code changes.

## Best Practices

| Do | Why |
| --- | --- |
| **Treat `BaseConnector` as a hard contract.** | Adding a method touches every concrete connector. |
| **Use `registerConnector(Class)` at boot, not at request time.** | Registration is process-wide and cheap; re-registering per request is wasteful. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Importing a vendor SDK from business code.** | Defeats the abstraction; couples the platform to one vendor. |
| **Adding a connector without `BaseConnector`.** | Bypasses the lifecycle contract; the connector cannot be previewed or tested uniformly. |

---

## Summary

Phase 1.1 ships the connector framework and the infrastructure facades
that let every later feature plug in without refactoring. Phase 1.1 is
complete; the first concrete connector lands in Sprint 6.

## Key Takeaways

- **One contract for every external system.** `BaseConnector`
  defines the lifecycle; the registry enforces uniqueness.
- **One interface per infrastructure layer.** Cache, storage and
  queue are provider-agnostic; provider is chosen by env, not by code.
- **No concrete connector is registered yet.** Sprint 6 registers
  the first two.

## Interview Preparation

### Common Questions

- "How do you support many data sources without coupling the
  platform to any one vendor?"
- "Why is the connector framework a separate phase from the
  foundation?"

### Sample Answers

- **"Many data sources without vendor coupling?"** — A single
  `BaseConnector` contract with a lifecycle every connector follows
  (`connect`, `validate`, `preview`, `ingest`, `disconnect`). A
  `ConnectorRegistry` enforces uniqueness. Business code calls
  `createConnector('csv', context)` and never imports
  `csv-parse` or `googleapis`. Adding a Sheets connector is one new
  class registered at boot.

- **"Why a separate phase?"** — Because the framework is a contract;
  contracts must be set before implementations. Phase 1.1 ships the
  contract; Phase 2 / Sprint 6 ships the first implementation. Doing
  them in the wrong order means either a rigid framework (because
  one connector shaped it) or a refactor (because the framework was
  retrofitted).

### Real-World Examples

- Phase 1.1 ships `BaseConnector` + stubs. Sprint 6 ships `CsvConnector`
  + `WebhookConnector`. Both plug into the framework unchanged.

### Common Mistakes

- Treating the framework as "almost done" once stubs exist. The
  stubs are placeholders; Sprint 6 is where they become real.

## Related Documents

- [`../README.md`](../README.md) — documentation homepage
- [`../03-product-roadmap.md`](../03-product-roadmap.md) — phase-by-phase plan
- [`phase-1.md`](./phase-1.md) — previous phase
- [`phase-1.2.md`](./phase-1.2.md) — next phase
- [`../../connectors/README.md`](../../connectors/README.md) — connector framework
- [`sprint-6.md`](./sprint-6.md) — first concrete connectors

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 1.1 — Connector & Infrastructure Architecture
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)