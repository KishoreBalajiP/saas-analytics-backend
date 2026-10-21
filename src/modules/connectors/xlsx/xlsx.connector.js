/**
 * XlsxConnector - the XLSX spreadsheet connector (Sprint 9).
 *
 * WHY IT EXISTS
 *   Excel files are a common ingestion path alongside CSV. This provider
 *   wraps ExcelJS's streaming WorkbookReader (behind the zip-bomb guard in
 *   `xlsx.zipGuard.js`) so rows are parsed one at a time and the workbook is
 *   never materialised. Config is plain (non-secret) and encrypted at rest.
 *
 * CONFIG (plain, non-secret):
 *   { hasHeader?: boolean, sheet?: string|number }
 *
 * CODING GUIDELINES
 *   - Stream rows with ExcelJS's WorkbookReader; yield one record at a time.
 *   - Rows per sync are capped (`CONNECTOR_MAX_ROWS_PER_SYNC`): exceeding the
 *     cap fails the sync with `ROW_LIMIT_EXCEEDED` instead of exhausting memory.
 *   - `connect` / `disconnect` are no-ops; `validate` + `preview` + `ingest`
 *     are the real surface.
 *   - The `sheet` config can be a sheet name (string) or a zero-based index (number).
 */

import BaseConnector from '../../../connectors/BaseConnector.js';
import { validateConfig } from '../shared/validators.js';
import { previewXlsx, createRowIterator } from './xlsx.parser.js';

export class XlsxConnector extends BaseConnector {
  static type = 'xlsx';
  static displayName = 'XLSX Import';
  static description = 'Stream-parse uploaded XLSX files into connector rows.';
  static capabilities = ['validate', 'preview', 'ingest'];

  async connect() {
    this.connected = true;
  }

  async validate() {
    const { valid, errors } = validateConfig('xlsx', this.config);
    return { valid, errors };
  }

  async preview({ buffer, limit = 10 } = {}) {
    if (!buffer) throw new Error('XlsxConnector.preview requires a file buffer');
    return previewXlsx(buffer, { ...this.config, limit });
  }

  async *ingest({ buffer, maxRows } = {}) {
    if (!buffer) throw new Error('XlsxConnector.ingest requires a file buffer');
    const iterator = createRowIterator(buffer, this.config, maxRows ? { maxRows } : {});
    for await (const record of iterator) {
      yield record;
    }
  }

  async disconnect() {
    this.connected = false;
  }
}

export default XlsxConnector;