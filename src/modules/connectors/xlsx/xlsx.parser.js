/**
 * XLSX parsing utilities - streaming, bounded (ExcelJS WorkbookReader).
 *
 * WHY IT EXISTS
 *   Shared parsing logic for preview + ingest so both paths stay in sync.
 *   Rows are STREAMED with ExcelJS's `stream.xlsx.WorkbookReader`; the
 *   workbook is never materialised.
 *
 * SAFETY (untrusted uploads)
 *   Before any XML is parsed, `xlsx.zipGuard.js` checks the archive (no
 *   encryption / ZIP64, bounded entry count), measures the REAL inflated
 *   size of the parts we read against `CONNECTOR_XLSX_MAX_UNCOMPRESSED_MB`,
 *   and re-orders the parts so the streaming reader never buffers sheets to
 *   temporary files. While streaming, rows are capped
 *   (`CONNECTOR_MAX_ROWS_PER_SYNC`) and so are columns per row
 *   (`CONNECTOR_XLSX_MAX_COLUMNS`). Library errors are mapped to generic,
 *   typed `ConnectorError`s.
 *
 * SHEET SELECTION
 *   `config.sheet` may be a sheet NAME (string) or a zero-based INDEX
 *   (number, in workbook order). Default: the first sheet.
 */

import ExcelJS from 'exceljs';
import env from '../../../config/env.js';
import { ConnectorError, RowLimitError, CONNECTOR_ERROR_CODES } from '../shared/errors.js';
import { inspectXlsx, measureInflatedSize, createOrderedXlsxStream } from './xlsx.zipGuard.js';

const READER_OPTIONS = Object.freeze({
  worksheets: 'emit',
  sharedStrings: 'cache',
  // Styles are needed to recognise date-formatted numbers.
  styles: 'cache',
  hyperlinks: 'ignore',
  entries: 'ignore',
});

function limitsFrom(opts = {}) {
  return {
    maxRows: opts.maxRows ?? env.connectors.maxRowsPerSync,
    maxColumns: opts.maxColumns ?? env.connectors.xlsxMaxColumns,
    maxUncompressedBytes: opts.maxUncompressedBytes ?? env.connectors.xlsxMaxUncompressedBytes,
  };
}

const parseFailed = (message = 'The file is not a valid XLSX workbook.') =>
  new ConnectorError(CONNECTOR_ERROR_CODES.FILE_PARSE_FAILED, message, { statusCode: 422 });

/** Normalise an ExcelJS cell value to a JSON-friendly primitive (or Date). */
export function toPrimitive(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value.richText)) return value.richText.map((r) => r?.text ?? '').join('');
  if ('formula' in value || 'sharedFormula' in value || 'result' in value) return toPrimitive(value.result ?? null);
  if ('error' in value) return null;
  if ('text' in value) return toPrimitive(value.text);
  return null;
}

function headerFields(values) {
  const seen = new Map();
  return values.map((v, i) => {
    const base = toPrimitive(v);
    let name = base === null || base === '' ? `col_${i}` : String(base);
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count > 0) name = `${name}_${count + 1}`;
    return name;
  });
}

/**
 * Stream the rows (as value arrays, 0-based) of the selected sheet.
 * Yields `{ sheetName, sheets, values }` (`sheets`: every sheet name in tab order).
 */
async function* streamSheetRows(buffer, config, limits) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw parseFailed();
  let inspection;
  try {
    inspection = inspectXlsx(buffer, { maxUncompressedBytes: limits.maxUncompressedBytes });
    await measureInflatedSize(buffer, inspection, { maxUncompressedBytes: limits.maxUncompressedBytes });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw parseFailed();
  }

  const source = createOrderedXlsxStream(buffer, inspection);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(source, READER_OPTIONS);
  const wanted = config.sheet;
  let found = false;
  let names = [];
  try {
    for await (const worksheet of reader) {
      const sheets = reader.model?.sheets ?? [];
      names = sheets.map((s) => String(s.name ?? '')).filter(Boolean);
      const position = sheets.findIndex((s) => String(s.id) === String(worksheet.id));
      // Default: the first sheet in workbook (tab) order, which is not
      // necessarily the first sheet part in the archive; a sheet the
      // workbook does not list falls back to archive order.
      const isWanted = wanted === undefined || wanted === null || wanted === ''
        ? position === 0 || position < 0
        : typeof wanted === 'number'
          ? position === wanted
          : worksheet.name === wanted;
      if (!isWanted) continue; // the reader drains the part without parsing it
      found = true;
      for await (const row of worksheet) {
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        if (values.length > limits.maxColumns) {
          throw new ConnectorError(
            'XLSX_TOO_MANY_COLUMNS',
            `A row has more than ${limits.maxColumns} columns, the maximum supported.`,
            {
              statusCode: 413,
              details: [{ field: 'file', message: `at most ${limits.maxColumns} columns per row`, maxColumns: limits.maxColumns }],
            },
          );
        }
        yield { sheetName: worksheet.name, sheets: names, values };
      }
      // A selected sheet without rows still reports its name and the sheet list.
      yield { sheetName: worksheet.name, sheets: names, values: null };
      return;
    }
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw parseFailed();
  } finally {
    source.destroy();
  }
  if (!found) {
    throw new ConnectorError('XLSX_SHEET_NOT_FOUND', 'The configured sheet was not found in the workbook.', {
      statusCode: 422,
      details: [{ field: 'sheet', message: 'not found in the workbook', sheets: names.slice(0, 50) }],
    });
  }
}

/**
 * Extract the first N rows for preview + field detection.
 *
 * @param {Buffer} buffer
 * @param {Object} config - { hasHeader?: boolean, sheet?: string|number, limit?: number }
 * @param {Object} [opts] - limit overrides (tests).
 * @returns {Promise<{ fields: string[], sample: Array<Object>, meta: Object }>}
 */
export async function previewXlsx(buffer, config = {}, opts = {}) {
  const limits = limitsFrom(opts);
  const limit = Math.max(1, Math.min(Number(config.limit) || 10, 100));
  const hasHeader = config.hasHeader ?? true;
  let fields = null;
  let sheetName = null;
  let sheets = [];
  const sample = [];
  let truncated = false;
  for await (const { sheetName: name, sheets: all, values } of streamSheetRows(buffer, config, limits)) {
    sheetName = name;
    sheets = all;
    if (values === null) break;
    if (fields === null) {
      fields = hasHeader ? headerFields(values) : values.map((_, i) => `col_${i}`);
      if (hasHeader) continue;
    }
    if (sample.length >= limit) {
      truncated = true;
      break;
    }
    sample.push(toRecord(fields, values));
  }
  return {
    fields: fields ?? [],
    sample,
    meta: { sheetName, sheets: sheets.slice(0, 50), rowCount: sample.length, hasHeader, truncated },
  };
}

function toRecord(fields, values) {
  const record = {};
  const width = Math.max(fields.length, values.length);
  for (let i = 0; i < width; i += 1) {
    const field = fields[i] ?? `col_${i}`;
    record[field] = toPrimitive(values[i]);
  }
  return record;
}

/**
 * Create an async iterable yielding one record at a time.
 *
 * @param {Buffer} buffer
 * @param {Object} config - { hasHeader?: boolean, sheet?: string|number }
 * @param {Object} [opts] - limit overrides (tests).
 * @returns {AsyncIterable<Object>}
 * @throws {RowLimitError} when the sheet has more data rows than allowed.
 */
export async function* createRowIterator(buffer, config = {}, opts = {}) {
  const limits = limitsFrom(opts);
  const hasHeader = config.hasHeader ?? true;
  let fields = null;
  let rows = 0;
  for await (const { values } of streamSheetRows(buffer, config, limits)) {
    if (values === null) break;
    if (fields === null) {
      fields = hasHeader ? headerFields(values) : values.map((_, i) => `col_${i}`);
      if (hasHeader) continue;
    }
    rows += 1;
    if (rows > limits.maxRows) throw new RowLimitError(limits.maxRows);
    yield toRecord(fields, values);
  }
}

export default { previewXlsx, createRowIterator, toPrimitive };
