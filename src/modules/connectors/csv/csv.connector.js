/**
 * CsvConnector - the CSV file connector (Sprint 4).
 *
 * WHY IT EXISTS
 *   CSV is the most common ingestion path. `CsvConnector` extends
 *   `BaseConnector` and owns CSV-specific concerns: config validation,
 *   header detection and stream-parse preview. It never persists anything -
 *   the service parses the upload via `ingest()` (an async iterable) and
 *   enqueues row batches for the sync worker.
 *
 * CONFIG (plain, non-secret; encrypted at rest with the rest of `config`):
 *   { delimiter?: string, hasHeader?: boolean }
 *
 * CODING GUIDELINES
 *   - Stream, never materialise: `ingest()` yields one record at a time so
 *     a 1 GB file never lives in memory.
 *   - `connect` / `disconnect` are no-ops (there is no persistent
 *     connection); `validate` + `preview` + `ingest` are the real surface.
 */

import BaseConnector from '../../../connectors/BaseConnector.js';
import env from '../../../config/env.js';
import { validateConfig } from '../shared/validators.js';
import { RowLimitError } from '../shared/errors.js';
import { createParser, previewCsv, toRecord } from './csv.parser.js';

export class CsvConnector extends BaseConnector {
  static type = 'csv';
  static displayName = 'CSV Import';
  static description = 'Stream-parse uploaded CSV files into connector rows.';
  static capabilities = ['validate', 'preview', 'ingest'];

  /** CSV files carry no persistent connection. */
  async connect() {
    this.connected = true;
  }

  /** Validate the stored CSV config (delimiter / hasHeader). */
  async validate() {
    const { valid, errors } = validateConfig('csv', this.config);
    return { valid, errors };
  }

  /**
   * Preview the first rows + detected fields without ingesting.
   *
   * @param {Object} [options]
   * @param {Buffer} options.buffer - uploaded file bytes.
   * @param {number} [options.limit=10]
   * @returns {Promise<{ fields: string[], sample: Array, meta: Object }>}
   */
  async preview({ buffer, limit = 10 } = {}) {
    if (!buffer) throw new Error('CsvConnector.preview requires a file buffer');
    return previewCsv(buffer, { ...this.config, limit });
  }

  /**
   * Stream the parsed records. Provider side of the pipeline only - returns
   * an async iterable the sync worker consumes.
   *
   * @param {Object} [options]
   * @param {Buffer} options.buffer - uploaded file bytes.
   * @param {number} [options.maxRows] - row cap (defaults to CONNECTOR_MAX_ROWS_PER_SYNC).
   * @returns {AsyncIterable<Object|Array>}
   * @throws {RowLimitError} when the file has more rows than one sync may ingest.
   */
  async *ingest({ buffer, maxRows = env.connectors.maxRowsPerSync } = {}) {
    if (!buffer) throw new Error('CsvConnector.ingest requires a file buffer');
    const parser = createParser(buffer, this.config);
    let rows = 0;
    try {
      for await (const record of parser) {
        rows += 1;
        if (rows > maxRows) throw new RowLimitError(maxRows);
        yield toRecord(record);
      }
    } finally {
      parser.destroy?.();
    }
  }

  async disconnect() {
    this.connected = false;
  }
}

export default CsvConnector;
