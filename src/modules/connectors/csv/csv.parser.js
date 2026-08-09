/**
 * CSV parser - streaming parse with header detection.
 *
 * WHY IT EXISTS
 *   CSV uploads can be large; loading the whole file as an array of rows
 *   OOMs the process. `csv-parse` (already a dependency) exposes an async
 *   iterable so rows stream through the pipeline one at a time with
 *   backpressure, and are batched downstream by the sync engine / service.
 *
 * RESPONSIBILITY
 *   - `createParser(buffer, options)` - async iterable of records.
 *   - `previewCsv(buffer, options)` - first N records + field names (used
 *     by the CSV connector's `preview`).
 *   - `detectHeader(buffer, options)` - heuristic: a first row whose cells
 *     are all numeric is treated as data (headerless), otherwise as headers.
 *
 * CODING GUIDELINES
 *   - `columns: true` yields objects keyed by the header row; headerless
 *     files yield arrays (mapped by index downstream).
 *   - Parser errors (malformed quoting, column-count mismatch) propagate
 *     as exceptions the caller maps to a `ConnectorError`.
 */

import { parse } from 'csv-parse';

/** Base options shared by every parse. */
function baseOptions({ delimiter, hasHeader } = {}) {
  return {
    bom: true,
    delimiter: delimiter ?? ',',
    columns: hasHeader !== false,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  };
}

/**
 * Create an async iterable of parsed records. Uses `columns: true` (object
 * rows) when `hasHeader` is truthy (default), otherwise array rows.
 *
 * @param {Buffer|string} buffer - file bytes.
 * @param {Object} [options] - { delimiter?, hasHeader? }.
 * @returns {AsyncIterable<Object|Array>}
 */
export function createParser(buffer, options = {}) {
  const parser = parse(baseOptions(options));
  const feed = async () => {
    if (buffer) parser.write(buffer);
    parser.end();
  };
  feed();
  return parser;
}

/**
 * Read the first `limit` records and the detected field names.
 *
 * @param {Buffer|string} buffer
 * @param {Object} [options] - { delimiter?, hasHeader?, limit? }.
 * @returns {Promise<{ fields: string[], sample: Array<Object|Array>, meta: Object }>}
 */
export async function previewCsv(buffer, { delimiter, hasHeader, limit = 10 } = {}) {
  const useHeader = hasHeader ?? (await detectHeader(buffer, { delimiter }));
  const parser = createParser(buffer, { delimiter, hasHeader: useHeader });
  const sample = [];
  for await (const record of parser) {
    sample.push(record);
    if (sample.length >= limit) break;
  }
  const fields = useHeader && sample.length > 0
    ? Object.keys(sample[0])
    : Array.from({ length: Array.isArray(sample[0]) ? sample[0].length : 0 }, (_, i) => `column_${i + 1}`);
  return {
    fields,
    sample,
    meta: { hasHeader: useHeader, rowCount: sample.length, truncated: true },
  };
}

/**
 * Heuristic header detection: a first non-empty row where every cell is a
 * number is treated as data (no header); otherwise headers are assumed.
 *
 * @param {Buffer|string} buffer
 * @param {Object} [options] - { delimiter? }.
 * @returns {Promise<boolean>} true when the file looks header-bearing.
 */
export async function detectHeader(buffer, { delimiter } = {}) {
  const parser = parse({
    ...baseOptions({ delimiter, hasHeader: false }),
    skip_empty_lines: true,
  });
  if (buffer) parser.write(buffer);
  parser.end();

  for await (const record of parser) {
    const cells = Array.isArray(record) ? record : Object.values(record ?? {});
    if (cells.length === 0) continue;
    const allNumeric = cells.every((c) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(String(c ?? '').trim()));
    return !allNumeric;
  }
  return true;
}

export default { createParser, previewCsv, detectHeader };
