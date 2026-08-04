# Connectors: shared

Planned scope - NOT implemented in Phase 1.1.

Shared, connector-agnostic building blocks that multiple connectors reuse so
each connector stays small and consistent.

Planned shared pieces:

- `field-mapping.js` - generic source-field -> target-field mapping engine
  (used by CSV, Google Sheets and MongoDB connectors alike)
- `sync-engine.js` - orchestrates `preview -> map -> ingest` with batching,
  idempotency and progress/state tracking
- `validators.js` - common config validation (URI formats, ranges, ...)
- `errors.js` - connector-specific error taxonomy mapped to `ApiError`

Rules
- `shared/` must NOT import vendor SDKs or implement provider logic.
- Anything here is used by two or more connectors; single-connector helpers
  stay in their own connector folder.
