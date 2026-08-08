# Module — Status

**Sprint:** 4 — Connector Platform
**Status:** 🕏 In Progress

**Implements:** the `csv` connector — `multer` upload (size-capped), stream
parse with backpressure (`csv-parse`), field mapping, and idempotent ingest via
the connector queue into `ConnectorRow`.

**Real source files (in progress):**

- `src/modules/connectors/csv/csv.connector.js`
- `src/modules/connectors/csv/csv.parser.js`
