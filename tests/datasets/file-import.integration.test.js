/**
 * datasets: the Upload file workflow over real HTTP against an in-memory
 * MongoDB, end to end at the API level:
 *
 *   preview before a dataset exists (CSV, multi-sheet XLSX) -> name ->
 *   import (connector + queued sync in one request) -> worker -> ready ->
 *   schema -> analytics query -> dashboard -> widgets (auto-placed, no
 *   overlap) -> reopen -> execute -> publish
 *
 * plus: header-less CSV rows are stored (not skipped), empty / header-only /
 * unsupported files, duplicate names, permissions, tenant isolation, and a
 * dataset whose import has not succeeded is refused with DATASET_NOT_READY.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api, apiMultipart } from '../helpers/http.js';
import { buildXlsx, sheetXml } from '../helpers/zip.js';
import { entitleTenant } from '../helpers/billing.js';
import { onboardTenant, memberOf } from '../platform-config/helpers.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import connectorService from '../../src/services/connector.service.js';
import { connectorQueue } from '../../src/queues/connector.queue.js';
import { Connector } from '../../src/models/Connector.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { SyncRun } from '../../src/models/SyncRun.js';

let captured = [];

before(async () => {
  await startMongo();
  await startHttp();
  // Capture sync jobs; each test runs the worker step explicitly.
  connectorQueue.getQueue().consume((job) => { captured.push(job); });
});
beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  await cacheService.flushAll();
  captured = [];
});
after(async () => { await stopHttp(); await stopMongo(); });

const CSV = [
  'order_id,region,amount,created_at',
  '1,EU,10.5,2026-01-03',
  '2,US,5,2026-01-04',
  '3,EU,"1,000",2026-02-01',
  '4,APAC,,2026-02-02',
].join('\n');

const csvFile = (text = CSV, name = 'orders.csv') => ({ buffer: Buffer.from(text, 'utf8'), type: 'text/csv', name });

async function workspace() {
  const t = await onboardTenant();
  await entitleTenant(t.tenantId);
  return t;
}

async function runQueuedSync() {
  assert.ok(captured.length, 'a sync job was queued');
  return connectorService.processSyncMessage(captured.shift());
}

const queryString = (params) => new URLSearchParams(
  Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
).toString();

test('CSV: preview -> import -> ready -> schema -> query -> dashboard widget -> reopen -> publish', async () => {
  const t = await workspace();

  // 1. Preview before any dataset exists: nothing is stored.
  const preview = await apiMultipart('/api/v1/connectors/file-preview', { headers: t.headers, fields: { hasHeader: 'true' }, file: csvFile() });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.data.type, 'csv');
  assert.deepEqual(preview.json.data.fields, ['order_id', 'region', 'amount', 'created_at']);
  assert.equal(preview.json.data.sample[2].amount, '1,000', 'quoted value with an embedded delimiter stays one cell');
  assert.equal(preview.json.data.filename, 'orders.csv');
  assert.equal(await Connector.countDocuments({ tenantId: t.tenantId }), 0);

  // 2. Import with a name: connector created, import queued, not ready yet.
  const imported = await apiMultipart('/api/v1/connectors/import', { headers: t.headers, fields: { name: '  Orders 2026 ', hasHeader: 'true' }, file: csvFile() });
  assert.equal(imported.status, 202, JSON.stringify(imported.json));
  const datasetId = String(imported.json.data.connector._id);
  assert.equal(imported.json.data.connector.name, 'Orders 2026');
  assert.equal(imported.json.data.connector.type, 'csv');
  assert.equal(imported.json.data.sync.status, 'queued');
  const run = await SyncRun.findById(imported.json.data.sync.syncRunId).lean();
  assert.equal(run.filename, 'orders.csv', 'original filename kept as metadata');

  // While the first import is queued, queries say so instead of returning nothing.
  const early = await api(`/api/v1/analytics?${queryString({ connectorIds: datasetId, metrics: [{ op: 'count', alias: 'n' }] })}`, { headers: t.headers });
  assert.equal(early.status, 409, JSON.stringify(early.json));
  assert.equal(early.json.code, 'DATASET_NOT_READY');

  // 3. Worker runs: dataset becomes ready with all rows.
  await runQueuedSync();
  const ready = await api(`/api/v1/connectors/${datasetId}`, { headers: t.headers });
  assert.equal(ready.json.data.syncStatus, 'succeeded');
  assert.ok(ready.json.data.lastSyncedAt);
  assert.equal(await ConnectorRow.countDocuments({ tenantId: t.tenantId, connectorId: datasetId }), 4);

  // 4. Schema discovered from the real rows.
  const schema = await api(`/api/v1/connectors/${datasetId}/schema`, { headers: t.headers });
  assert.equal(schema.status, 200);
  const names = schema.json.data.fields.map((f) => f.name).sort();
  assert.deepEqual(names, ['amount', 'created_at', 'order_id', 'region']);

  // 5. Analytics query over the imported data.
  const q = await api(`/api/v1/analytics?${queryString({ connectorIds: datasetId, metrics: [{ op: 'count', alias: 'orders' }], groupBy: ['region'] })}`, { headers: t.headers });
  assert.equal(q.status, 200, JSON.stringify(q.json));
  const byRegion = Object.fromEntries(q.json.data.map((r) => [r.region, r.orders]));
  assert.deepEqual(byRegion, { EU: 2, US: 1, APAC: 1 });

  // 6. Draft dashboard, then two widgets without positions: auto-placed side by side.
  const dash = await api('/api/v1/dashboards', { method: 'POST', headers: t.headers, body: { name: 'Sales' } });
  assert.equal(dash.status, 201);
  const dashboardId = dash.json.data._id;
  assert.equal(dash.json.data.status, 'draft');
  const emptyPublish = await api(`/api/v1/dashboards/${dashboardId}/publish`, { method: 'POST', headers: t.headers, body: {} });
  assert.equal(emptyPublish.status, 400, 'an empty dashboard cannot be published');
  assert.equal(emptyPublish.json.code, 'DASHBOARD_PUBLISH_INVALID');

  const widgetBody = (name) => ({ name, type: 'bar', datasetId, query: { metrics: [{ op: 'count', alias: 'orders' }], groupBy: [{ field: 'region' }] } });
  const w1 = await api(`/api/v1/dashboards/${dashboardId}/widgets`, { method: 'POST', headers: t.headers, body: widgetBody('Orders by region') });
  const w2 = await api(`/api/v1/dashboards/${dashboardId}/widgets`, { method: 'POST', headers: t.headers, body: widgetBody('Orders again') });
  assert.equal(w1.status, 201, JSON.stringify(w1.json));
  assert.equal(w2.status, 201, JSON.stringify(w2.json));
  assert.deepEqual(w1.json.data.position, { x: 0, y: 0, w: 6, h: 4 });
  assert.deepEqual(w2.json.data.position, { x: 6, y: 0, w: 6, h: 4 }, 'second widget does not overlap the first');

  // 7. Reopen the draft: widgets and layout persisted; execution reads real data.
  const reopened = await api(`/api/v1/dashboards/${dashboardId}?includeWidgets=true`, { headers: t.headers });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.data.status, 'draft');
  assert.equal(reopened.json.data.widgets.length, 2);
  const exec = await api(`/api/v1/dashboards/${dashboardId}/execute`, { headers: t.headers });
  assert.equal(exec.status, 200);
  assert.ok(exec.json.data.every((w) => w.status === 'ok'), JSON.stringify(exec.json.data));
  assert.equal(exec.json.data[0].result.rows.reduce((sum, r) => sum + r.orders, 0), 4);

  // 8. Publish validates every widget and succeeds.
  const published = await api(`/api/v1/dashboards/${dashboardId}/publish`, { method: 'POST', headers: t.headers, body: {} });
  assert.equal(published.status, 200, JSON.stringify(published.json));
  assert.equal(published.json.data.status, 'published');
});

test('XLSX: preview lists sheets, the chosen sheet is imported, a missing sheet names the options', async () => {
  const t = await workspace();
  const book = buildXlsx([
    { name: 'Summary', xml: sheetXml([['note'], ['ignore me']]) },
    { name: 'Data', xml: sheetXml([['sku', 'qty'], ['A', 3], ['B', 4]]) },
  ]);
  const file = { buffer: book, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'stock.xlsx' };

  const first = await apiMultipart('/api/v1/connectors/file-preview', { headers: t.headers, file });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.data.type, 'xlsx');
  assert.deepEqual(first.json.data.meta.sheets, ['Summary', 'Data']);
  assert.equal(first.json.data.meta.sheetName, 'Summary');

  const data = await apiMultipart('/api/v1/connectors/file-preview', { headers: t.headers, fields: { sheet: 'Data' }, file });
  assert.deepEqual(data.json.data.fields, ['sku', 'qty']);
  assert.equal(data.json.data.sample.length, 2);

  const missing = await apiMultipart('/api/v1/connectors/file-preview', { headers: t.headers, fields: { sheet: 'Nope' }, file });
  assert.equal(missing.status, 422);
  assert.equal(missing.json.code, 'XLSX_SHEET_NOT_FOUND');
  assert.deepEqual(missing.json.errors[0].sheets, ['Summary', 'Data']);

  const imported = await apiMultipart('/api/v1/connectors/import', { headers: t.headers, fields: { name: 'Stock', sheet: 'Data' }, file });
  assert.equal(imported.status, 202, JSON.stringify(imported.json));
  await runQueuedSync();
  const rows = await ConnectorRow.find({ tenantId: t.tenantId, connectorId: imported.json.data.connector._id }).lean();
  assert.deepEqual(rows.map((r) => r.data.sku).sort(), ['A', 'B']);
});

test('header-less CSV rows are stored under column_N names, not skipped', async () => {
  const t = await workspace();
  const text = '1,EU,10\n2,US,20\n';
  const preview = await apiMultipart('/api/v1/connectors/file-preview', { headers: t.headers, fields: { hasHeader: 'false' }, file: csvFile(text, 'raw.csv') });
  assert.deepEqual(preview.json.data.fields, ['column_1', 'column_2', 'column_3']);
  assert.equal(preview.json.data.sample[0].column_2, 'EU');

  const imported = await apiMultipart('/api/v1/connectors/import', { headers: t.headers, fields: { name: 'Raw', hasHeader: 'false' }, file: csvFile(text, 'raw.csv') });
  assert.equal(imported.status, 202, JSON.stringify(imported.json));
  await runQueuedSync();
  const rows = await ConnectorRow.find({ tenantId: t.tenantId, connectorId: imported.json.data.connector._id }).lean();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.data.column_2).sort(), ['EU', 'US']);
});

test('bad uploads are refused without leaving a dataset behind', async () => {
  const t = await workspace();
  const empty = await apiMultipart('/api/v1/connectors/import', { headers: t.headers, fields: { name: 'Empty' }, file: csvFile('', 'empty.csv') });
  assert.ok([400, 422].includes(empty.status), JSON.stringify(empty.json));

  const headerOnly = await apiMultipart('/api/v1/connectors/import', { headers: t.headers, fields: { name: 'Header only' }, file: csvFile('a,b,c\n', 'h.csv') });
  assert.equal(headerOnly.status, 422, JSON.stringify(headerOnly.json));

  const binary = await apiMultipart('/api/v1/connectors/import', {
    headers: t.headers, fields: { name: 'Image' }, file: { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), type: 'image/png', name: 'pic.png' },
  });
  assert.equal(binary.status, 415, JSON.stringify(binary.json));

  const xls = await apiMultipart('/api/v1/connectors/import', { headers: t.headers, fields: { name: 'Legacy' }, file: { buffer: Buffer.from('x'), type: 'application/vnd.ms-excel', name: 'old.xls' } });
  assert.equal(xls.status, 415);

  const noName = await apiMultipart('/api/v1/connectors/import', { headers: t.headers, fields: {}, file: csvFile() });
  assert.equal(noName.status, 422);
  assert.equal(noName.json.errors[0].field, 'name');

  assert.equal(await Connector.countDocuments({ tenantId: t.tenantId }), 0, 'no dataset was created');
  assert.equal(captured.length, 0, 'no import was queued');
});

test('dataset names are unique per workspace (case-insensitive), not across workspaces', async () => {
  const t = await workspace();
  const other = await workspace();
  const first = await apiMultipart('/api/v1/connectors/import', { headers: t.headers, fields: { name: 'Orders' }, file: csvFile() });
  assert.equal(first.status, 202);
  const dup = await apiMultipart('/api/v1/connectors/import', { headers: t.headers, fields: { name: ' orders ' }, file: csvFile() });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'DATASET_NAME_TAKEN');
  const elsewhere = await apiMultipart('/api/v1/connectors/import', { headers: other.headers, fields: { name: 'Orders' }, file: csvFile() });
  assert.equal(elsewhere.status, 202);
});

test('permissions and tenant isolation', async () => {
  const t = await workspace();
  const viewer = await memberOf(t.tenantId, 'Viewer');
  const denied = await apiMultipart('/api/v1/connectors/import', { headers: viewer.headers, fields: { name: 'Nope' }, file: csvFile() });
  assert.equal(denied.status, 403);

  const imported = await apiMultipart('/api/v1/connectors/import', { headers: t.headers, fields: { name: 'Orders' }, file: csvFile() });
  await runQueuedSync();
  const datasetId = String(imported.json.data.connector._id);

  // Another workspace cannot read the dataset, its rows or build a widget on it.
  const other = await workspace();
  const detail = await api(`/api/v1/connectors/${datasetId}`, { headers: other.headers });
  assert.equal(detail.status, 404);
  const q = await api(`/api/v1/analytics?${queryString({ connectorIds: datasetId, metrics: [{ op: 'count', alias: 'n' }] })}`, { headers: other.headers });
  assert.ok(q.status !== 200 || q.json.data.every((r) => !r.n), 'no rows from another workspace');
  const dash = await api('/api/v1/dashboards', { method: 'POST', headers: other.headers, body: { name: 'Steal' } });
  const steal = await api(`/api/v1/dashboards/${dash.json.data._id}/widgets`, {
    method: 'POST', headers: other.headers, body: { name: 'x', type: 'kpi', datasetId, query: { metrics: [{ op: 'count', alias: 'n' }] } },
  });
  assert.equal(steal.status, 400);
});

test('a dataset whose first import failed is refused with DATASET_NOT_READY', async () => {
  const t = await workspace();
  const failed = await Connector.create({ tenantId: t.tenantId, type: 'csv', name: 'Broken', status: 'active', syncStatus: 'failed', lastError: 'parse error' });
  const res = await api(`/api/v1/analytics?${queryString({ connectorIds: String(failed._id), metrics: [{ op: 'count', alias: 'n' }] })}`, { headers: t.headers });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'DATASET_NOT_READY');
  assert.match(res.json.message, /import failed/);

  // A dataset that already holds data stays queryable while a re-sync fails.
  await Connector.updateOne({ _id: failed._id }, { $set: { lastSyncedAt: new Date() } });
  const ok = await api(`/api/v1/analytics?${queryString({ connectorIds: String(failed._id), metrics: [{ op: 'count', alias: 'n' }] })}`, { headers: t.headers });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});
