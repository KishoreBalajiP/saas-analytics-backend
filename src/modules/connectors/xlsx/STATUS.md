# XLSX Connector Module Status

## Status: Implemented (Sprint 9), hardened (Phase 1, roadmap 1.7)

## Overview
The XLSX connector ingests uploaded `.xlsx` workbooks. Rows are streamed with
ExcelJS's `stream.xlsx.WorkbookReader`; the workbook is never loaded whole.
Legacy `.xls` (binary) files are not supported and are refused with 415.

## Files
- `index.js` - Provider registration (auto-registers at boot)
- `xlsx.connector.js` - Connector class extending BaseConnector
- `xlsx.parser.js` - Streaming preview / row iterator (row and column caps)
- `xlsx.zipGuard.js` - Zip-bomb guard: central-directory checks, real
  inflated-size measurement, part re-ordering so the streaming reader never
  writes temporary files

## Configuration
Plain (non-secret) config fields:
- `hasHeader` (boolean, default: true) - first row contains column names
- `sheet` (string | integer, default: first sheet) - sheet name, or zero-based index

## Limits
- Upload size: `CONNECTOR_XLSX_MAX_UPLOAD_MB` (413 `FILE_TOO_LARGE`)
- Inflated size of the parts read: `CONNECTOR_XLSX_MAX_UNCOMPRESSED_MB` (413 `FILE_TOO_LARGE`)
- Rows per sync: `CONNECTOR_MAX_ROWS_PER_SYNC` (`ROW_LIMIT_EXCEEDED`)
- Columns per row: `CONNECTOR_XLSX_MAX_COLUMNS` (`XLSX_TOO_MANY_COLUMNS`)
- Encrypted / ZIP64 / non-deflate archives: 422 `FILE_PARSE_FAILED`

## Security
- Content sniffing in the upload middleware (ZIP + OOXML workbook); the
  connector service re-checks that the file type matches the connector type
- Library errors are mapped to generic, typed errors (no internals echoed)
- Config encrypted at rest with tenant-scoped encryption context

## Tests
- `tests/modules/connectors/xlsx/xlsx.parser.test.js` - header / no header,
  sheet by name and index, row and column caps, zip bombs (honest and lying
  sizes), no temp files, no full-workbook load
- `tests/connectors/connector-safety.integration.test.js` - HTTP preview,
  413 / 415 upload errors
