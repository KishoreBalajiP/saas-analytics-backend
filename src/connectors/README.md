# Connectors - framework

The platform ingests data from many external systems. Instead of building a
bespoke "data source" implementation for each one, every external system is
modeled as a **connector** behind one common contract.

## Why connectors

- One architecture, many providers: CSV, Google Sheets, Webhooks, MongoDB,
  PostgreSQL, MySQL, REST APIs, GraphQL, Snowflake, BigQuery, ...
- Business logic (sync, field mapping, dashboards, analytics) talks to the
  contract - never to a vendor SDK. Adding a provider never touches callers.
- Every connector follows the same lifecycle, so validation, preview,
  ingestion and teardown behave identically across providers.

## The connector contract

Every connector implements the `BaseConnector` lifecycle:

| Method        | Responsibility                                                    |
| ------------- | ----------------------------------------------------------------- |
| `connect()`   | Open the connection / driver / handshake to the external system.  |
| `validate()`  | Prove the stored config is accepted by the provider.              |
| `preview()`   | Show what is available BEFORE ingesting (fields, sample rows).    |
| `ingest()`    | Read source data and push it into the ingestion pipeline.         |
| `disconnect()`| Release connections / resources cleanly.                          |

Plus built-in metadata (`type`, `displayName`, `capabilities`) and helpers
(`testConnection()`, `getStatus()`). Base methods **fail closed** - they throw
until a concrete connector implements them, so nothing silently no-ops.

## How to add a connector

1. Create `src/modules/connectors/<type>/<type>.connector.js` extending
   `BaseConnector`, with a static `type`.
2. Implement the lifecycle methods (see `BaseConnector.js` JSDoc for each
   method's expected payload/return shape).
3. Register it once at boot:
   `registerConnector(MongoDbConnector)` (see `ConnectorRegistry.js`).
4. Add the HTTP surface in `src/routes/connector.routes.js` and the module's
   router under `src/modules/connectors/<type>/`.

The registry resolves `type -> class` at runtime; callers never import a
concrete connector directly. Example consumer:

```js
import { createConnector } from '../connectors/index.js';

const connector = createConnector('mongodb', { id, config, tenantId });
await connector.validate();
```

## Folder responsibilities

| Path                              | Responsibility                                    |
| --------------------------------- | ------------------------------------------------- |
| `src/connectors/`                 | framework: contract + registry (provider-agnostic)|
| `src/connectors/BaseConnector.js` | the lifecycle contract every connector extends    |
| `src/connectors/ConnectorRegistry.js` | dynamic type -> class lookup + factory        |
| `src/connectors/index.js`         | public facade (`connectors.create(...)`)          |
| `src/modules/connectors/<type>/`  | concrete implementations (csv, google-sheets, ...)|
| `src/modules/connectors/shared/`  | reusable pieces across connectors (field mapping, sync engine, ...) |

## Status

Phase 1.1 ships the **architecture only** - no connector is implemented and
none are registered yet. The registry will stay empty until Phase 2.
