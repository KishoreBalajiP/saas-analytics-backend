/**
 * Artifact Service (roadmap 1.5).
 *
 * PURPOSE
 *   Writes the WHOLE result of an analytics query into storage as a file a
 *   person can open: CSV, JSON or a real XLSX workbook. Shared by report
 *   runs (`report.service.processRun`) and analytics exports
 *   (`analyticsExport.service.processExport`).
 *
 * HOW
 *   Rows come from one engine cursor (`engine.openRowStream`, no pages) and
 *   are written to a storage write stream as they arrive, so memory stays
 *   flat however large the result is. XLSX uses the exceljs streaming
 *   workbook writer. Backpressure from storage is honoured.
 *
 * LIMITS
 *   - `ARTIFACT_MAX_ROWS` (env `artifacts.maxRows`) is a hard safety cap.
 *     When the result has more rows the artefact holds the first `cap`
 *     rows and the outcome says `truncated: true` (`rowLimit` names the
 *     cap). Below the cap `truncated` is false and the file is complete.
 *   - XLSX is additionally capped at 1,048,575 data rows (sheet limit).
 *   - A raw result with more than `engine.STREAM_MAX_COLUMNS` columns fails
 *     with 422 TOO_MANY_COLUMNS instead of dropping columns.
 *
 * FILE CONTENTS
 *   - Grouped / KPI queries: one column per group field and metric alias.
 *   - Raw queries: one column per data key (sorted), values from `data`.
 *   - CSV: RFC 4180 quoting, UTF-8, text cells that a spreadsheet would run
 *     as a formula (`=`, `+`, `-`, `@`, tab, CR) are prefixed with `'`.
 *   - XLSX: numbers, booleans and dates keep their type; numeric text
 *     (no leading zeros, at most 15 digits) becomes a number; text is
 *     capped at Excel's 32,767 characters per cell.
 *   - JSON: `{ columns, generatedAt, rows: [...], rowCount, truncated, rowLimit }`.
 *
 * FAILURE
 *   On any error the partial object is deleted and the error is rethrown.
 */

import { once } from 'node:events';
import ExcelJS from 'exceljs';
import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import clock from '../utils/clock.js';
import * as engine from './analytics.engine.js';
import * as storageService from './storage.service.js';

export const ARTIFACT_FORMAT_NAMES = Object.freeze(['csv', 'json', 'xlsx']);

export const ARTIFACT_FORMATS = Object.freeze({
  csv: Object.freeze({ ext: 'csv', contentType: 'text/csv; charset=utf-8' }),
  json: Object.freeze({ ext: 'json', contentType: 'application/json; charset=utf-8' }),
  xlsx: Object.freeze({ ext: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
});

/** Artefacts written before real XLSX support were HTML tables named `.xls`. */
const LEGACY_CONTENT_TYPES = Object.freeze({ xls: 'application/vnd.ms-excel' });

/** Data rows one worksheet can hold (1,048,576 minus the header row). */
export const XLSX_MAX_DATA_ROWS = 1048575;
const XLSX_MAX_CELL_CHARS = 32767;
/** CSV/JSON rows buffered into one write. */
const WRITE_BATCH_ROWS = 500;
/** XLSX rows between backpressure checks. */
const XLSX_DRAIN_EVERY = 1000;

const NUMERIC_TEXT_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const FORMULA_START_RE = /^[=+\-@\t\r]/;
const XLSX_NUMBER_RE = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
// XML 1.0 forbids these control characters; they would corrupt the sheet.
// eslint-disable-next-line no-control-regex
const XML_INVALID_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/* -------------------------------- helpers -------------------------------- */

/** Content type of a stored artefact, from its key's extension. */
export function contentTypeForKey(key) {
  const ext = String(key ?? '').split('.').pop().toLowerCase();
  const known = Object.values(ARTIFACT_FORMATS).find((f) => f.ext === ext);
  return known?.contentType ?? LEGACY_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Download file name: `<name>-<YYYY-MM-DD-HHmm>.<ext>` (UTC), restricted to
 * characters that are safe in headers and on every file system.
 */
export function artifactFileName(name, formatOrExt, at = clock.now()) {
  const ext = ARTIFACT_FORMATS[formatOrExt]?.ext ?? String(formatOrExt || 'csv');
  const stamp = at.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const base = storageService.safeFileName(String(name ?? '').replace(/\./g, '-')).toLowerCase().slice(0, 100);
  return `${base}-${stamp}.${ext}`;
}

/** The values written for one result row. */
function recordOf(row, groupMode) {
  if (groupMode) return row;
  const data = row?.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function textOf(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') {
    // BSON scalars (ObjectId, Decimal128, Long) print as their value.
    if (value._bsontype) return String(value);
    return JSON.stringify(value);
  }
  return String(value);
}

/** One CSV cell: quoted when needed; formula-looking text neutralised. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = textOf(value);
  if (typeof value === 'string' && FORMULA_START_RE.test(text) && !NUMERIC_TEXT_RE.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One XLSX cell value with its natural type. */
export function xlsxCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'bigint') return value.toString();
  const text = textOf(value).replace(XML_INVALID_RE, '');
  if (typeof value === 'string' && XLSX_NUMBER_RE.test(text)) return Number(text);
  return text.length > XLSX_MAX_CELL_CHARS ? text.slice(0, XLSX_MAX_CELL_CHARS) : text;
}

/**
 * A worksheet name Excel accepts: no `\ / ? * [ ] :` or XML-invalid
 * characters, no leading/trailing apostrophe, at most 31 characters, not
 * blank and not the reserved name "History" (the streaming writer does not
 * check these, and Excel would have to repair the workbook).
 */
export function xlsxSheetName(name) {
  const cleaned = String(name ?? '')
    .replace(XML_INVALID_RE, '')
    .replace(/[\\/?*[\]:]/g, ' ')
    .trim()
    .slice(0, 31)
    .replace(/^[\s']+|[\s']+$/g, '');
  if (!cleaned) return 'Report';
  return cleaned.toLowerCase() === 'history' ? 'History data' : cleaned;
}

/** Write a chunk, waiting for the sink to drain when its buffer is full. */
async function writeChunk(sink, chunk) {
  if (!sink.write(chunk)) await once(sink, 'drain');
}

/* -------------------------------- writers -------------------------------- */

function csvWriter(sink, columns) {
  let lines = [columns.map(csvCell).join(',')];
  return {
    async row(record) {
      lines.push(columns.map((c) => csvCell(record[c])).join(','));
      if (lines.length >= WRITE_BATCH_ROWS) {
        const chunk = `${lines.join('\n')}\n`;
        lines = [];
        await writeChunk(sink, chunk);
      }
    },
    async end() {
      if (lines.length) await writeChunk(sink, `${lines.join('\n')}\n`);
      lines = [];
      sink.end();
    },
  };
}

function jsonWriter(sink, columns, { generatedAt }) {
  let pending = `{"columns":${JSON.stringify(columns)},"generatedAt":${JSON.stringify(generatedAt)},"rows":[`;
  let first = true;
  let buffered = 0;
  return {
    async row(record) {
      pending += `${first ? '' : ','}${JSON.stringify(record)}`;
      first = false;
      buffered += 1;
      if (buffered >= WRITE_BATCH_ROWS) {
        const chunk = pending;
        pending = '';
        buffered = 0;
        await writeChunk(sink, chunk);
      }
    },
    async end({ rowCount, truncated, rowLimit }) {
      pending += `],"rowCount":${rowCount},"truncated":${truncated},"rowLimit":${rowLimit === null ? 'null' : rowLimit}}`;
      await writeChunk(sink, pending);
      pending = '';
      sink.end();
    },
  };
}

function xlsxWriter(sink, columns, { sheetName }) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: false, useSharedStrings: false });
  workbook.creator = 'Analivo';
  const sheet = workbook.addWorksheet(xlsxSheetName(sheetName));
  sheet.addRow(columns.map((c) => String(c).replace(XML_INVALID_RE, ''))).commit();
  let written = 0;
  return {
    async row(record) {
      sheet.addRow(columns.map((c) => xlsxCell(record[c]))).commit();
      written += 1;
      if (written % XLSX_DRAIN_EVERY === 0 && sink.writableNeedDrain) await once(sink, 'drain');
    },
    async end() {
      sheet.commit();
      // Finalises the zip and ends the sink.
      await workbook.commit();
    },
  };
}

const WRITERS = Object.freeze({ csv: csvWriter, json: jsonWriter, xlsx: xlsxWriter });

/* ------------------------------- service --------------------------------- */

/**
 * Stream the whole result of `query` into storage under `key`.
 *
 * @param {Object} opts
 * @param {Object} opts.query - engine options (public query + `tenantId`,
 *   `connectorIds`, optional `filterGroups`). `pagination` is ignored: an
 *   artefact always covers the whole result.
 * @param {'csv'|'json'|'xlsx'} opts.format
 * @param {string} opts.key - storage key.
 * @param {number} [opts.maxRows] - safety cap (default `ARTIFACT_MAX_ROWS`).
 * @param {string} [opts.sheetName] - XLSX worksheet name.
 * @returns {Promise<{ key: string, format: string, contentType: string, size: number,
 *   rowCount: number, truncated: boolean, rowLimit: number|null, columns: string[],
 *   groupMode: boolean, window: object|null, timezone: string }>}
 */
export async function writeQueryArtifact({ query, format, key, maxRows = env.artifacts.maxRows, sheetName = 'Report' } = {}) {
  const spec = ARTIFACT_FORMATS[format];
  if (!spec) {
    throw ApiError.badRequest('Invalid artefact format', [{ field: 'format', message: `must be one of ${ARTIFACT_FORMAT_NAMES.join(', ')}` }]);
  }
  const requested = Math.max(1, Math.floor(Number(maxRows) || env.artifacts.maxRows));
  const cap = format === 'xlsx' ? Math.min(requested, XLSX_MAX_DATA_ROWS) : requested;
  const { pagination: _ignored, ...options } = query || {};

  const result = await engine.openRowStream(options, { maxTimeMS: env.artifacts.queryTimeoutMs });
  const { columns, groupMode } = result;
  let sink = null;
  let rowCount = 0;
  let truncated = false;
  try {
    sink = await storageService.createWriteStream(key, { contentType: spec.contentType });
    const writer = WRITERS[format](sink, columns, { generatedAt: clock.now().toISOString(), sheetName });
    for await (const row of result.rows) {
      if (rowCount >= cap) {
        // One row past the cap proves the result is larger than the file.
        truncated = true;
        break;
      }
      await writer.row(recordOf(row, groupMode));
      rowCount += 1;
    }
    const rowLimit = truncated ? cap : null;
    await writer.end({ rowCount, truncated, rowLimit });
    const { size } = await sink.completed;
    return {
      key,
      format,
      contentType: spec.contentType,
      size,
      rowCount,
      truncated,
      rowLimit,
      columns,
      groupMode,
      window: result.window,
      timezone: result.timezone,
    };
  } catch (err) {
    // Close the cursor (if it is still open) and drop the partial object.
    await result.rows.return?.().catch(() => {});
    if (sink && !sink.destroyed) sink.destroy(err);
    await storageService.del(key).catch(() => {});
    throw err;
  }
}

export default {
  writeQueryArtifact,
  artifactFileName,
  xlsxSheetName,
  contentTypeForKey,
  csvCell,
  xlsxCell,
  ARTIFACT_FORMATS,
  ARTIFACT_FORMAT_NAMES,
  XLSX_MAX_DATA_ROWS,
};
