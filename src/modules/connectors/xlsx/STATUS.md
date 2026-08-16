# XLSX Connector Module Status

## Status: Implemented (Sprint 9)

## Overview
The XLSX connector allows tenants to upload `.xlsx`/`.xls` spreadsheet files for ingestion. It uses ExcelJS for streaming row parsing and integrates with the shared connector sync engine.

## Files
- `index.js` - Provider registration (auto-registers at boot)
- `xlsx.connector.js` - Connector class extending BaseConnector
- `xlsx.parser.js` - Shared ExcelJS parsing utilities

## Configuration
Plain (non-secret) config fields:
- `hasHeader` (boolean, default: true) - first row contains column names
- `sheet` (string|number, default: 0) - sheet name or index to parse

## Capabilities
- `validate` - validates config via shared validators
- `preview` - returns first N rows + detected fields without ingesting
- `ingest` - streams parsed records as async iterable

## API Endpoints
- `POST /api/v1/connectors` with `type: 'xlsx'` - create connector
- `POST /api/v1/connectors/:id/preview` - preview uploaded file (multipart)
- `POST /api/v1/connectors/:id/sync` - enqueue file sync (multipart)

## Security
- File size capped by `CONNECTOR_XLSX_MAX_UPLOAD_MB` (default 10 MB)
- MIME type + extension validation in upload middleware
- Config encrypted at rest with tenant-scoped encryption context
- No credentials in XLSX config (file-based, not connection-based)

## Tests
- Unit: `tests/connectors/xlsx.connector.test.js` (validates config, preview, ingest)
- Integration: covered by connector sync flow tests

## Dependencies
- `exceljs` - spreadsheet parsing (added in Sprint 9)