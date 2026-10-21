/**
 * Artefact writing building blocks (roadmap 1.5):
 *   - engine.openRowStream: one cursor over the whole result, columns known
 *     up front, pagination refused, tenant-scoped, analytics slot released
 *     even when the consumer stops early;
 *   - cell formatting for CSV (quoting, formula neutralisation) and XLSX
 *     (typed values), file names and content types.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { openRowStream } from '../../src/services/analytics.engine.js';
import { queryLimiter } from '../../src/services/analytics.limiter.js';
import * as artifactService from '../../src/services/artifact.service.js';

useMongo();

const TA = 'tenant-artifact-a';
const TB = 'tenant-artifact-b';
const ca = new mongoose.Types.ObjectId();

beforeEach(async () => {
  await resetMongo();
  await ConnectorRow.insertMany([
    ...Array.from({ length: 450 }, (_, i) => ({ tenantId: TA, connectorId: ca, sourceRowId: `a${i}`, data: { n: i, region: i % 2 ? 'EU' : 'US', ...(i === 7 ? { extra: 'x' } : {}) } })),
    ...Array.from({ length: 20 }, (_, i) => ({ tenantId: TB, connectorId: ca, sourceRowId: `b${i}`, data: { secret: 'tenant-b' } })),
  ]);
});

async function collect(stream) {
  const rows = [];
  for await (const row of stream.rows) rows.push(row);
  return rows;
}

test('openRowStream streams every row of a raw query with all columns known up front', async () => {
  const stream = await openRowStream({ tenantId: TA, connectorIds: [String(ca)], orderBy: [{ field: 'n', direction: 'asc' }] });
  assert.equal(stream.groupMode, false);
  assert.deepEqual(stream.columns, ['extra', 'n', 'region'], 'every data key of the matching rows, sorted');
  const rows = await collect(stream);
  assert.equal(rows.length, 450, 'not one page of 50 or 200');
  assert.deepEqual(rows.slice(0, 3).map((r) => r.data.n), [0, 1, 2]);
  assert.equal(typeof rows[0].connectorId, 'string');
  assert.ok(rows.every((r) => !('secret' in r.data)), 'tenant-scoped');
  assert.deepEqual(queryLimiter.stats(TA), { active: 0, queued: 0 });
});

test('openRowStream reports grouped columns and refuses pagination', async () => {
  const grouped = await openRowStream({ tenantId: TA, groupBy: ['region'], metrics: [{ op: 'count' }, { op: 'max', field: 'n', alias: 'top' }] });
  assert.deepEqual(grouped.columns, ['region', 'count', 'top']);
  assert.deepEqual(await collect(grouped), [{ region: 'EU', count: 225, top: 449 }, { region: 'US', count: 225, top: 448 }]);

  await assert.rejects(
    () => openRowStream({ tenantId: TA, pagination: { page: 1 } }),
    (e) => e.statusCode === 400 && e.code === 'INVALID_QUERY' && e.errors.some((x) => x.field === 'pagination'),
  );
  await assert.rejects(() => openRowStream({ tenantId: TA, filters: [{ field: 'n', op: 'like', value: 1 }] }), (e) => e.code === 'INVALID_QUERY');
});

test('openRowStream refuses results wider than the column limit', async () => {
  await assert.rejects(
    () => openRowStream({ tenantId: TA }, { maxColumns: 2 }),
    (e) => e.statusCode === 422 && e.code === 'TOO_MANY_COLUMNS',
  );
});

test('a consumer that stops early closes the cursor and frees the analytics slot', async () => {
  const stream = await openRowStream({ tenantId: TA }, { batchSize: 10 });
  let seen = 0;
  for await (const _row of stream.rows) {
    seen += 1;
    assert.equal(queryLimiter.stats(TA).active, 1, 'the cursor holds one slot while open');
    if (seen === 15) break;
  }
  assert.deepEqual(queryLimiter.stats(TA), { active: 0, queued: 0 });
});

test('CSV cells are quoted and formula-looking text is neutralised', () => {
  const { csvCell } = artifactService;
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(12.5), '12.5');
  assert.equal(csvCell(-3), '-3', 'numbers are never prefixed');
  assert.equal(csvCell('-3'), '-3', 'numeric text is never prefixed');
  assert.equal(csvCell('+44 20 7946 0000'), "'+44 20 7946 0000");
  assert.equal(csvCell('=1+2'), "'=1+2");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('-2+3+cmd|calc'), "'-2+3+cmd|calc");
  assert.equal(csvCell('\tx'), "'\tx");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell(true), 'true');
  assert.equal(csvCell(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z');
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  assert.equal(csvCell(new mongoose.Types.ObjectId('0123456789abcdef01234567')), '0123456789abcdef01234567');
});

test('XLSX cells keep their type', () => {
  const { xlsxCell } = artifactService;
  assert.equal(xlsxCell(null), null);
  assert.equal(xlsxCell(4.5), 4.5);
  assert.equal(xlsxCell('42'), 42, 'numeric text becomes a number');
  assert.equal(xlsxCell('-0.5'), -0.5);
  assert.equal(xlsxCell('007'), '007', 'leading zeros stay text');
  assert.equal(xlsxCell('1234567890123456789'), '1234567890123456789', 'too many digits for a double stay text');
  assert.equal(xlsxCell('1e5'), '1e5');
  assert.equal(xlsxCell(true), true);
  const date = new Date('2026-01-02T00:00:00Z');
  assert.equal(xlsxCell(date), date);
  assert.equal(xlsxCell(Number.NaN), 'NaN');
  assert.equal(xlsxCell('a\u0000b\u0007c'), 'abc', 'XML-invalid control characters are removed');
  assert.equal(xlsxCell('x'.repeat(40_000)).length, 32_767);
  assert.equal(xlsxCell({ a: [1] }), '{"a":[1]}');
});

test('file names and content types', () => {
  const at = new Date('2026-10-20T09:05:00Z');
  assert.equal(artifactService.artifactFileName('Q3 Sales: EU', 'xlsx', at), 'q3-sales-eu-2026-10-20-0905.xlsx');
  assert.equal(artifactService.artifactFileName('', 'csv', at), 'download-2026-10-20-0905.csv');
  assert.equal(artifactService.contentTypeForKey('a/b.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(artifactService.contentTypeForKey('a/b.csv'), 'text/csv; charset=utf-8');
  assert.equal(artifactService.contentTypeForKey('a/b.json'), 'application/json; charset=utf-8');
  assert.equal(artifactService.contentTypeForKey('a/legacy.xls'), 'application/vnd.ms-excel', 'artefacts written before real XLSX');
  assert.equal(artifactService.contentTypeForKey('a/b.bin'), 'application/octet-stream');
});

test('writeQueryArtifact refuses an unknown format', async () => {
  await assert.rejects(
    () => artifactService.writeQueryArtifact({ query: { tenantId: TA }, format: 'pdf', key: 'x/y.pdf' }),
    (e) => e.statusCode === 400 && e.errors.some((x) => x.field === 'format'),
  );
});

test('XLSX worksheet names are ones Excel accepts', async () => {
  const { xlsxSheetName } = artifactService;
  assert.equal(xlsxSheetName('Q3 sales/EU: [draft]?'), 'Q3 sales EU   draft');
  assert.equal(xlsxSheetName("'Quoted'"), 'Quoted', 'no leading or trailing apostrophe');
  assert.equal(xlsxSheetName('History'), 'History data', '"History" is reserved by Excel');
  assert.equal(xlsxSheetName('history'), 'History data');
  assert.equal(xlsxSheetName('   '), 'Report');
  assert.equal(xlsxSheetName('???'), 'Report');
  assert.equal(xlsxSheetName(null), 'Report');
  assert.equal(xlsxSheetName('a\u0000b'), 'ab', 'XML-invalid characters are removed');
  const long = xlsxSheetName(`${'x'.repeat(30)}'tail`);
  assert.ok(long.length <= 31 && !long.endsWith("'"), long);

  // A workbook written for a report named "History" opens with a valid sheet.
  const out = await artifactService.writeQueryArtifact({
    query: { tenantId: TA, connectorIds: [String(ca)], groupBy: ['region'] },
    format: 'xlsx',
    key: `tests/${TA}/history.xlsx`,
    sheetName: 'History',
  });
  assert.equal(out.rowCount, 2);
  const { default: ExcelJS } = await import('exceljs');
  const { get: getObject, del: delObject } = await import('../../src/services/storage.service.js');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await getObject(out.key));
  assert.equal(workbook.worksheets[0].name, 'History data');
  assert.equal(workbook.worksheets[0].actualRowCount, 3);
  await delObject(out.key);
});
