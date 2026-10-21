/**
 * Tests for the streaming XLSX parser + zip-bomb guard (roadmap 1.7,
 * findings con.11 / sec.10): header / no-header, sheet by name and index,
 * row and column caps enforced while streaming, inflated-size budget
 * (including archives that lie about their sizes), no temp files and no
 * full-workbook load.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { previewXlsx, createRowIterator, toPrimitive } from '../../../../src/modules/connectors/xlsx/xlsx.parser.js';
import { inspectXlsx, measureInflatedSize } from '../../../../src/modules/connectors/xlsx/xlsx.zipGuard.js';
import { XlsxConnector } from '../../../../src/modules/connectors/xlsx/xlsx.connector.js';
import { validateConfig } from '../../../../src/modules/connectors/shared/validators.js';
import { buildXlsx, buildZip, sheetXml } from '../../../helpers/zip.js';

const require = createRequire(import.meta.url);

async function excelWorkbook(rowsBySheet) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(rowsBySheet)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function collect(iterable) {
  const out = [];
  for await (const r of iterable) out.push(r);
  return out;
}

/** Count calls to a module function while `fn` runs. */
async function countCalls(target, method, fn) {
  const original = target[method];
  let calls = 0;
  target[method] = function counted(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    await fn();
  } finally {
    target[method] = original;
  }
  return calls;
}

test('preview with header row returns records keyed by header, dates as Date values', async () => {
  const buf = await excelWorkbook({ Orders: [['id', 'name', 'when'], [1, 'Ada', new Date(Date.UTC(2024, 0, 2))], [2, 'Bob', null]] });
  const preview = await previewXlsx(buf, { limit: 10 });
  assert.deepEqual(preview.fields, ['id', 'name', 'when']);
  assert.equal(preview.sample.length, 2);
  assert.equal(preview.sample[0].name, 'Ada');
  assert.ok(preview.sample[0].when instanceof Date);
  assert.equal(preview.sample[1].when, null);
  assert.equal(preview.meta.sheetName, 'Orders');
  assert.equal(preview.meta.truncated, false);
});

test('without a header row every row is data (the first row is not dropped)', async () => {
  const buf = buildXlsx([{ name: 'S', xml: sheetXml([[1, 'a'], [2, 'b']]) }]);
  const rows = await collect(createRowIterator(buf, { hasHeader: false }));
  assert.deepEqual(rows, [{ col_0: 1, col_1: 'a' }, { col_0: 2, col_1: 'b' }]);
});

test('sheet selection by name and by zero-based index; unknown sheet is a typed error', async () => {
  const buf = await excelWorkbook({ First: [['a'], [1]], Second: [['b'], [2]], Third: [['c'], [3]] });
  assert.deepEqual(await collect(createRowIterator(buf, { sheet: 'Second' })), [{ b: 2 }]);
  assert.deepEqual(await collect(createRowIterator(buf, { sheet: 2 })), [{ c: 3 }]);
  assert.deepEqual(await collect(createRowIterator(buf, {})), [{ a: 1 }]);
  await assert.rejects(() => collect(createRowIterator(buf, { sheet: 'Nope' })), (e) => e.code === 'XLSX_SHEET_NOT_FOUND' && e.statusCode === 422);
  await assert.rejects(() => collect(createRowIterator(buf, { sheet: 9 })), (e) => e.code === 'XLSX_SHEET_NOT_FOUND');
});

test('default sheet and sheet indexes follow workbook (tab) order, not archive order', async () => {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  // sheet1.xml is the SECOND tab, sheet2.xml the FIRST (tabs were reordered).
  const buf = buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: '_rels/.rels', data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml([['tab'], ['second']]) },
    { name: 'xl/worksheets/sheet2.xml', data: sheetXml([['tab'], ['first']]) },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="First" sheetId="2" r:id="rId2"/><sheet name="Second" sheetId="1" r:id="rId1"/></sheets></workbook>` },
  ]);
  assert.deepEqual(await collect(createRowIterator(buf, {})), [{ tab: 'first' }]);
  assert.deepEqual(await collect(createRowIterator(buf, { sheet: 0 })), [{ tab: 'first' }]);
  assert.deepEqual(await collect(createRowIterator(buf, { sheet: 1 })), [{ tab: 'second' }]);
  assert.equal((await previewXlsx(buf, {})).meta.sheetName, 'First');
});

test('validator accepts a numeric sheet index and a sheet name, rejects garbage', () => {
  assert.equal(validateConfig('xlsx', { sheet: 0 }).valid, true);
  assert.equal(validateConfig('xlsx', { sheet: 'Data' }).valid, true);
  assert.equal(validateConfig('xlsx', { sheet: -1 }).valid, false);
  assert.equal(validateConfig('xlsx', { sheet: 1.5 }).valid, false);
  assert.equal(validateConfig('xlsx', { sheet: '' }).valid, false);
});

test('row cap is enforced while streaming: rows up to the cap are yielded, then ROW_LIMIT_EXCEEDED', async () => {
  const rows = [['n'], ...Array.from({ length: 500 }, (_, i) => [i])];
  const buf = buildXlsx([{ name: 'Big', xml: sheetXml(rows) }]);
  const seen = [];
  await assert.rejects(async () => {
    for await (const r of createRowIterator(buf, {}, { maxRows: 50 })) seen.push(r);
  }, (e) => e.code === 'ROW_LIMIT_EXCEEDED' && e.statusCode === 413 && e.details.limit === 50);
  assert.equal(seen.length, 50, 'stops at the cap instead of materialising the sheet');

  // The connector applies the same cap through `ingest({ maxRows })`.
  const connector = new XlsxConnector({ config: {} });
  await assert.rejects(() => collect(connector.ingest({ buffer: buf, maxRows: 10 })), (e) => e.code === 'ROW_LIMIT_EXCEEDED');
});

test('parsing streams with WorkbookReader: no full-workbook load and no temp files, even for sheets-first archives', async () => {
  const XLSX = require('exceljs/lib/xlsx/xlsx.js');
  const tmp = require('tmp');
  // Excel / ExcelJS write sheets before sharedStrings and workbook.xml.
  const excelBuf = await excelWorkbook({ A: [['x', 'y'], ['s1', 1], ['s2', 2]] });
  const handBuf = buildXlsx([{ name: 'H', xml: sheetXml([['k'], ['v']]) }]);
  let loads = 0;
  const tmpFiles = await countCalls(tmp, 'file', async () => {
    loads = await countCalls(XLSX.prototype, 'load', async () => {
      assert.equal((await collect(createRowIterator(excelBuf, {}))).length, 2);
      assert.equal((await collect(createRowIterator(handBuf, {}))).length, 1);
      await previewXlsx(excelBuf, { limit: 1 });
    });
  });
  assert.equal(loads, 0, 'workbook.xlsx.load (full materialisation) is never used');
  assert.equal(tmpFiles, 0, 'no worksheet is buffered to a temporary file');
});

test('zip bomb: declared inflated size over the budget is refused before parsing (413 FILE_TOO_LARGE)', async () => {
  const buf = buildXlsx([{ name: 'Bomb', xml: sheetXml([['a'], [1]], { padding: 8 * 1024 * 1024 }) }]);
  assert.ok(buf.length < 100 * 1024, 'tiny upload');
  await assert.rejects(() => previewXlsx(buf, {}, { maxUncompressedBytes: 2 * 1024 * 1024 }),
    (e) => e.code === 'FILE_TOO_LARGE' && e.statusCode === 413);
});

test('zip bomb that LIES about its sizes is caught by measuring the real inflated bytes', async () => {
  const buf = buildXlsx([{ name: 'Liar', xml: sheetXml([['a'], [1]], { padding: 8 * 1024 * 1024 }), declaredSize: 1000 }]);
  const inspection = inspectXlsx(buf, { maxUncompressedBytes: 2 * 1024 * 1024 });
  assert.ok(inspection.entries.length > 0, 'declared sizes pass the first check');
  await assert.rejects(() => measureInflatedSize(buf, inspection, { maxUncompressedBytes: 2 * 1024 * 1024 }),
    (e) => e.code === 'FILE_TOO_LARGE');
  await assert.rejects(() => collect(createRowIterator(buf, {}, { maxUncompressedBytes: 2 * 1024 * 1024 })),
    (e) => e.code === 'FILE_TOO_LARGE');
});

test('column cap per row is enforced', async () => {
  const wide = Array.from({ length: 30 }, (_, i) => `c${i}`);
  const buf = buildXlsx([{ name: 'Wide', xml: sheetXml([wide]) }]);
  await assert.rejects(() => previewXlsx(buf, {}, { maxColumns: 10 }),
    (e) => e.code === 'XLSX_TOO_MANY_COLUMNS' && e.statusCode === 413 && e.details[0].maxColumns === 10 && e.details[0].field === 'file');
});

test('archives that are not usable workbooks fail with a generic FILE_PARSE_FAILED', async () => {
  const cases = [
    Buffer.from('id,name\n1,a\n'),
    buildZip([{ name: 'hello.txt', data: 'hi' }]),
    buildZip([{ name: 'xl/workbook.xml', data: '<x/>' }, { name: 'xl/_rels/workbook.xml.rels', data: '<x/>' }]),
    buildXlsx([{ name: 'Enc', xml: sheetXml([['a']]) }], { extraEntries: [{ name: 'secret.bin', data: 'x', flags: 1 }] }),
  ];
  for (const buf of cases) {
    await assert.rejects(() => previewXlsx(buf, {}), (e) => {
      assert.equal(e.code, 'FILE_PARSE_FAILED');
      assert.equal(e.statusCode, 422);
      return true;
    });
  }
});

test('a truncated sheet part yields no rows instead of crashing', async () => {
  const buf = buildXlsx([{ name: 'Broken', xml: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a' }]);
  const preview = await previewXlsx(buf, {});
  assert.deepEqual(preview.sample, []);
});

test('toPrimitive normalises ExcelJS cell value shapes', () => {
  assert.equal(toPrimitive({ richText: [{ text: 'a' }, { text: 'b' }] }), 'ab');
  assert.equal(toPrimitive({ formula: 'A1+1', result: 3 }), 3);
  assert.equal(toPrimitive({ error: '#DIV/0!' }), null);
  assert.equal(toPrimitive({ text: 'link', hyperlink: 'https://x' }), 'link');
  assert.equal(toPrimitive(Number.NaN), null);
  assert.equal(toPrimitive(undefined), null);
});
