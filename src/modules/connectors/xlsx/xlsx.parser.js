/**
 * XLSX parsing utilities (ExcelJS).
 *
 * WHY IT EXISTS
 *   Shared parsing logic for preview + ingest so both paths stay in sync.
 *   Uses ExcelJS's streaming row iteration to avoid full materialisation.
 *
 * NOTE
 *   ExcelJS loads the entire workbook into memory (it's not a true
 *   streaming parser like csv-parse). For production-scale files >100 MB
 *   consider a dedicated stream parser; the 10 MB upload cap keeps this
 *   acceptable for now.
 */

import ExcelJS from 'exceljs';

/**
 * Extract the first N rows for preview + field detection.
 *
 * @param {Buffer} buffer
 * @param {Object} config - { hasHeader?: boolean, sheet?: string|number, limit?: number }
 * @returns {Promise<{ fields: string[], sample: Array, meta: Object }>}
 */
export async function previewXlsx(buffer, config = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = config.sheet !== undefined
    ? (typeof config.sheet === 'string' ? workbook.getWorksheet(config.sheet) : workbook.getWorksheet(config.sheet))
    : workbook.worksheets[0];

  if (!sheet) throw new Error('Specified sheet not found');

  const rows = [];
  const hasHeader = config.hasHeader ?? true;
  let fields = [];
  let headerProcessed = false;

  sheet.eachRow((row, rowNumber) => {
    if (rows.length >= (config.limit ?? 10)) return;
    const values = row.values.slice(1); // ExcelJS uses 1-based indexing
    if (!headerProcessed) {
      if (hasHeader) {
        fields = values.map((v, i) => (v !== undefined && v !== null ? String(v) : `col_${i}`));
        headerProcessed = true;
        return;
      } else {
        fields = values.map((_, i) => `col_${i}`);
        headerProcessed = true;
      }
    }
    rows.push(values);
  });

  return {
    fields,
    sample: rows,
    meta: {
      sheetName: sheet.name,
      rowCount: sheet.rowCount,
      hasHeader,
    },
  };
}

/**
 * Create an async iterable yielding one record at a time.
 *
 * @param {Buffer} buffer
 * @param {Object} config - { hasHeader?: boolean, sheet?: string|number }
 * @returns {AsyncIterable<Object>}
 */
export async function* createRowIterator(buffer, config = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = config.sheet !== undefined
    ? (typeof config.sheet === 'string' ? workbook.getWorksheet(config.sheet) : workbook.getWorksheet(config.sheet))
    : workbook.worksheets[0];

  if (!sheet) throw new Error('Specified sheet not found');

  const hasHeader = config.hasHeader ?? true;
  let fields = [];
  let headerProcessed = false;

  for (const row of sheet.getRows(1, sheet.rowCount)) {
    const values = row.values.slice(1);
    if (!headerProcessed) {
      if (hasHeader) {
        fields = values.map((v, i) => (v !== undefined && v !== null ? String(v) : `col_${i}`));
      } else {
        fields = values.map((_, i) => `col_${i}`);
      }
      headerProcessed = true;
      continue;
    }
    const record = {};
    fields.forEach((field, i) => {
      const val = values[i];
      record[field] = val === undefined ? null : val;
    });
    yield record;
  }
}

export default { previewXlsx, createRowIterator };