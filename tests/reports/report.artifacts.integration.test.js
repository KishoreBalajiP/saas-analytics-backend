/**
 * Report artefacts hold the whole result (roadmap 1.5, finding ana.03).
 *
 *   - a report over MORE than the old 50,000-row pager limit produces a
 *     complete CSV and a real XLSX workbook (opened with exceljs, row count
 *     asserted), `rowCount` is the number of rows in the file and
 *     `truncated` stays false;
 *   - JSON artefacts carry every row plus `rowCount` / `truncated`;
 *   - grouped and KPI reports write one column per group field / metric;
 *   - the download is a short-lived signed URL that serves the file with
 *     the right content type and file name; tampered or expired links are
 *     refused; another workspace cannot mint one.
 *
 * The safety cap itself (`truncated: true`) is covered in
 * report.artifact-cap.test.js, which runs with a small ARTIFACT_MAX_ROWS.
 */

import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp } from '../helpers/http.js';
import { factories } from '../helpers/factories.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import * as reportService from '../../src/services/report.service.js';
import * as storageService from '../../src/services/storage.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import { queryLimiter } from '../../src/services/analytics.limiter.js';
import clock from '../../src/utils/clock.js';

const BIG = 50_050; // more than the old 50,000-row pager cap
const REGIONS = ['EU', 'US', 'APAC'];

let baseUrl;
let tenantId;
let datasetId;

before(async () => {
  await startMongo();
  baseUrl = await startHttp();
});
after(async () => { await stopHttp(); await stopMongo(); });
beforeEach(async () => {
  await resetMongo();
  await cacheService.flushAll();
  tenantId = String((await factories.tenant.create({ status: 'active' }))._id);
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active' });
  datasetId = String(connector._id);
});
afterEach(() => clock.reset());

/** Insert `n` order rows (raw driver, in batches, for speed). */
async function seedOrders(n, { tenant = tenantId, dataset = datasetId } = {}) {
  const connectorId = new mongoose.Types.ObjectId(dataset);
  const ingestedAt = new Date('2026-01-01T00:00:00Z');
  for (let start = 0; start < n; start += 10_000) {
    const batch = [];
    for (let i = start; i < Math.min(n, start + 10_000); i += 1) {
      batch.push({
        tenantId: tenant,
        connectorId,
        sourceRowId: `r${i}`,
        ingestedAt,
        data: { order_id: i, region: REGIONS[i % 3], amount: String(i % 100), note: i === 0 ? 'has, a comma and "quotes"' : 'ok' },
      });
    }
    await ConnectorRow.collection.insertMany(batch, { ordered: false });
  }
}

async function generate(reportId, format) {
  const { runId } = await reportService.run({ tenantId, reportId, format });
  await reportService.processRun({ tenantId, reportId, runId });
  const report = await reportService.getById({ tenantId, reportId });
  const run = report.runs.find((r) => String(r._id) === runId);
  assert.equal(run.status, 'ready', run.error ?? 'the run should succeed');
  return run;
}

/** Fetch a signed download URL (relative for local storage) through the app. */
async function fetchDownload(url) {
  const res = await fetch(url.startsWith('/') ? `${baseUrl}${url}` : url);
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}

test('a report over 50,000 rows produces a complete CSV and a real XLSX workbook', async () => {
  await seedOrders(BIG);
  const report = await reportService.create({ tenantId, name: 'All orders', source: 'query', format: 'csv', query: { datasetId } });
  const reportId = String(report._id);

  // CSV: every row, header first, RFC 4180 quoting.
  const csvRun = await generate(reportId, 'csv');
  assert.equal(csvRun.rowCount, BIG);
  assert.equal(csvRun.truncated, false);
  assert.equal(csvRun.rowLimit, null);
  assert.equal(csvRun.contentType, 'text/csv; charset=utf-8');
  assert.match(csvRun.fileName, /^all-orders-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/);
  assert.match(csvRun.resultKey, /\.csv$/);
  const csv = (await storageService.get(csvRun.resultKey)).toString('utf8');
  const records = parseCsv(csv, { columns: true });
  assert.equal(records.length, BIG, 'one CSV record per row');
  assert.deepEqual(Object.keys(records[0]), ['amount', 'note', 'order_id', 'region']);
  const ids = new Set(records.map((r) => r.order_id));
  assert.equal(ids.size, BIG, 'no row is missing or repeated');
  assert.equal(records.find((r) => r.order_id === '0').note, 'has, a comma and "quotes"');
  assert.equal(csvRun.size, Buffer.byteLength(csv));

  // XLSX: a real workbook (not an HTML table), opened with exceljs.
  const xlsxRun = await generate(reportId, 'xlsx');
  assert.equal(xlsxRun.rowCount, BIG);
  assert.equal(xlsxRun.truncated, false);
  assert.equal(xlsxRun.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(xlsxRun.fileName, /\.xlsx$/);
  const bytes = await storageService.get(xlsxRun.resultKey);
  assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK', 'an OOXML zip, not HTML');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.name, 'All orders');
  assert.equal(sheet.actualRowCount, BIG + 1, 'header + every row');
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['amount', 'note', 'order_id', 'region']);
  const row = sheet.getRow(2).values.slice(1);
  assert.equal(typeof row[0], 'number', 'numeric text is written as a number');
  assert.equal(typeof row[2], 'number');
  assert.ok(REGIONS.includes(row[3]));
});

test('JSON artefacts carry every row with rowCount and truncated', async () => {
  await seedOrders(1_234);
  const report = await reportService.create({ tenantId, name: 'Orders JSON', source: 'query', format: 'json', query: { datasetId } });
  const run = await generate(String(report._id), undefined);
  assert.equal(run.format, 'json');
  assert.equal(run.contentType, 'application/json; charset=utf-8');
  const body = JSON.parse((await storageService.get(run.resultKey)).toString('utf8'));
  assert.equal(body.rows.length, 1_234);
  assert.equal(body.rowCount, 1_234);
  assert.equal(body.truncated, false);
  assert.equal(body.rowLimit, null);
  assert.deepEqual(body.columns, ['amount', 'note', 'order_id', 'region']);
  assert.ok(body.generatedAt);
});

test('grouped and KPI reports write group fields and metric aliases, over every group', async () => {
  await seedOrders(3_000);
  const grouped = await reportService.create({
    tenantId, name: 'By region', source: 'query', format: 'csv',
    query: { datasetId, groupBy: ['region'], metrics: [{ op: 'count' }, { op: 'sum', field: 'amount', alias: 'revenue' }], orderBy: ['region'] },
  });
  const run = await generate(String(grouped._id), 'csv');
  assert.equal(run.rowCount, 3);
  const rows = parseCsv((await storageService.get(run.resultKey)).toString('utf8'), { columns: true });
  assert.deepEqual(rows.map((r) => r.region), ['APAC', 'EU', 'US']);
  assert.deepEqual(Object.keys(rows[0]), ['region', 'count', 'revenue']);
  assert.equal(rows.reduce((s, r) => s + Number(r.count), 0), 3_000);

  // 400 groups: more than one engine page (200); every group is written.
  const perOrder = await reportService.create({
    tenantId, name: 'Per order', source: 'query', format: 'xlsx',
    query: { datasetId, filters: [{ field: 'order_id', op: 'lt', value: 400 }], groupBy: ['order_id'], metrics: [{ op: 'count' }] },
  });
  const perOrderRun = await generate(String(perOrder._id), 'xlsx');
  assert.equal(perOrderRun.rowCount, 400);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await storageService.get(perOrderRun.resultKey));
  assert.equal(workbook.worksheets[0].actualRowCount, 401);

  const kpi = await reportService.create({
    tenantId, name: 'KPI', source: 'query', format: 'json', query: { datasetId, metrics: [{ op: 'avg', field: 'amount' }] },
  });
  const kpiRun = await generate(String(kpi._id), 'json');
  const body = JSON.parse((await storageService.get(kpiRun.resultKey)).toString('utf8'));
  assert.deepEqual(body.columns, ['avg_amount']);
  assert.equal(body.rows.length, 1);
  assert.equal(kpiRun.rowCount, 1);
});

test('CSV cells that a spreadsheet would run as formulas are neutralised; numbers are not', async () => {
  const connectorId = new mongoose.Types.ObjectId(datasetId);
  await ConnectorRow.collection.insertMany([
    { tenantId, connectorId, sourceRowId: 'a', data: { text: '=HYPERLINK("http://x","y")', n: '-12.5' } },
    { tenantId, connectorId, sourceRowId: 'b', data: { text: '@SUM(A1)', n: '+3' } },
  ]);
  const report = await reportService.create({ tenantId, name: 'Injection', source: 'query', format: 'csv', query: { datasetId, orderBy: ['text'] } });
  const run = await generate(String(report._id), 'csv');
  const rows = parseCsv((await storageService.get(run.resultKey)).toString('utf8'), { columns: true });
  assert.deepEqual(rows.map((r) => r.text), ["'=HYPERLINK(\"http://x\",\"y\")", "'@SUM(A1)"]);
  assert.deepEqual(rows.map((r) => r.n), ['-12.5', '+3']);
});

test('the artefact cursor releases its analytics slot, and a failed run stores nothing', async () => {
  await seedOrders(10);
  const report = await reportService.create({ tenantId, name: 'Slots', source: 'query', format: 'csv', query: { datasetId } });
  await generate(String(report._id), 'csv');
  assert.deepEqual(queryLimiter.stats(tenantId), { active: 0, queued: 0 });

  // Storage cannot write the file (a file blocks the run's directory): the
  // run fails with a generic message (never the server path), and nothing
  // is left behind.
  const blocked = await reportService.create({ tenantId, name: 'Blocked', source: 'query', format: 'csv', query: { datasetId } });
  const reportId = String(blocked._id);
  const blocker = `reports/${tenantId}/${reportId}`;
  await storageService.put(blocker, 'not a directory');
  const { runId } = await reportService.run({ tenantId, reportId, format: 'csv' });
  await reportService.processRun({ tenantId, reportId, runId });
  const after = await reportService.getById({ tenantId, reportId });
  const run = after.runs.find((r) => String(r._id) === runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'The report file could not be stored; please retry');
  assert.equal(run.resultKey, null);
  assert.deepEqual(queryLimiter.stats(tenantId), { active: 0, queued: 0 });
  await storageService.del(blocker);
});

test('downloads are short-lived signed URLs serving the file; bad or expired links and other workspaces are refused', async () => {
  await seedOrders(500);
  const report = await reportService.create({ tenantId, name: 'Q3 sales/EU', source: 'query', format: 'xlsx', query: { datasetId } });
  const reportId = String(report._id);
  await assert.rejects(() => reportService.download({ tenantId, reportId }), (e) => e.statusCode === 404, 'nothing generated yet');
  const run = await generate(reportId, 'xlsx');

  const descriptor = await reportService.download({ tenantId, reportId });
  assert.equal(descriptor.runId, String(run._id));
  assert.equal(descriptor.format, 'xlsx');
  assert.equal(descriptor.rowCount, 500);
  assert.equal(descriptor.truncated, false);
  assert.match(descriptor.fileName, /^q3-sales-eu-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/);
  assert.match(descriptor.url, /^\/api\/v1\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const ttlMs = new Date(descriptor.expiresAt).getTime() - Date.now();
  assert.ok(ttlMs > 0 && ttlMs <= 300_000 + 1000, 'expires within the configured TTL (300 s)');

  const { res, body } = await fetchDownload(descriptor.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="${descriptor.fileName}"`);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(body);
  assert.equal(workbook.worksheets[0].actualRowCount, 501);

  // A tampered token (another key) and a forged signature are refused.
  const [payload, signature] = descriptor.url.split('/').pop().split('.');
  const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const forged = Buffer.from(JSON.stringify({ ...grant, k: 'reports/other-tenant/x/y.xlsx' })).toString('base64url');
  for (const token of [`${forged}.${signature}`, `${payload}.${'A'.repeat(signature.length)}`, 'not-a-token']) {
    const bad = await fetchDownload(`/api/v1/files/${token}`);
    assert.equal(bad.res.status, 404);
    assert.equal(JSON.parse(bad.body.toString('utf8')).code, 'DOWNLOAD_LINK_INVALID');
  }

  // After the TTL the same link no longer works.
  clock.set(new Date(Date.now() + 301_000));
  const expired = await fetchDownload(descriptor.url);
  assert.equal(expired.res.status, 404);
  clock.reset();

  // Another workspace cannot mint a link for this report.
  const other = String((await factories.tenant.create({ status: 'active' }))._id);
  await assert.rejects(() => reportService.download({ tenantId: other, reportId }), (e) => e.statusCode === 404);
  await assert.rejects(() => reportService.download({ tenantId, reportId, runId: String(new mongoose.Types.ObjectId()) }), (e) => e.statusCode === 404);
});
