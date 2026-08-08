# Module — Status

**Sprint:** 4 — Connector Platform
**Status:** 🕏 In Progress

**Implements:** shared ingestion primitives — field mapping
(`sourceField → targetField`), the sync engine (resolves a connector, runs
its lifecycle, upserts rows idempotently), connector-level validators and
errors.

**Real source files (in progress):**

- `src/modules/connectors/shared/field-mapping.js`
- `src/modules/connectors/shared/sync-engine.js`
- `src/modules/connectors/shared/validators.js`
- `src/modules/connectors/shared/errors.js`
