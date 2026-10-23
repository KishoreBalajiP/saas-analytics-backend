/**
 * Integration tests for `services/dashboard.service.js` — dashboard CRUD,
 * publishing, duplication, soft-delete cascade and email share grants,
 * with tenant isolation checks throughout.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import * as cacheService from '../../src/services/cache.service.js';
import * as dashboardService from '../../src/services/dashboard.service.js';
import dashboardRepository from '../../src/repositories/dashboard.repository.js';
import widgetRepository from '../../src/repositories/widget.repository.js';
import { Dashboard } from '../../src/models/Dashboard.js';
import { Widget } from '../../src/models/Widget.js';
import { Role } from '../../src/models/Role.js';

useMongo();
const { ObjectId } = mongoose.Types;
const TA = 'tenant-a';
const TB = 'tenant-b';

beforeEach(async () => { await resetMongo(); await cacheService.flushAll(); });

test('create dashboard returns a draft with sane defaults', async () => {
  const d = await dashboardService.createDashboard({ tenantId: TA, actorId: 'u1', name: 'Revenue' });
  assert.equal(d.status, 'draft');
  assert.deepEqual(d.layout, { columns: 12, rowHeight: 80 });
  assert.deepEqual(d.shares, []);
  assert.equal(d.tenantId, TA);
});

test('create rejects a missing name', async () => {
  await assert.rejects(
    () => dashboardService.createDashboard({ tenantId: TA, name: '  ' }),
    (e) => e.statusCode === 400,
  );
});

test('list is tenant-scoped and sortable by status/search', async () => {
  await dashboardService.createDashboard({ tenantId: TA, name: 'Revenue' });
  await dashboardService.createDashboard({ tenantId: TA, name: 'Churn' });
  await dashboardService.createDashboard({ tenantId: TB, name: 'Other' });

  const a = await dashboardService.listDashboards({ tenantId: TA });
  assert.equal(a.total, 2);

  const b = await dashboardService.listDashboards({ tenantId: TB });
  assert.equal(b.total, 1);

  const searched = await dashboardService.listDashboards({ tenantId: TA, search: 'rev' });
  assert.equal(searched.total, 1);
  assert.equal(searched.docs[0].name, 'Revenue');

  const filtered = await dashboardService.listDashboards({ tenantId: TA, status: 'published' });
  assert.equal(filtered.total, 0);
});

test('getDashboard 404s on unknown or cross-tenant ids', async () => {
  const d = await dashboardService.createDashboard({ tenantId: TA, name: 'Revenue' });
  const id = String(d._id);

  await assert.rejects(
    () => dashboardService.getDashboard({ tenantId: TA, dashboardId: new ObjectId().toString() }),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    () => dashboardService.getDashboard({ tenantId: TB, dashboardId: id }),
    (e) => e.statusCode === 404,
  );
  const { dashboard } = await dashboardService.getDashboard({ tenantId: TA, dashboardId: id });
  assert.equal(dashboard.name, 'Revenue');
});

test('update whitelists known fields and ignores unknown keys', async () => {
  const d = await dashboardService.createDashboard({ tenantId: TA, name: 'Revenue' });
  const updated = await dashboardService.updateDashboard({
    tenantId: TA,
    dashboardId: String(d._id),
    actorId: 'u2',
    patch: { name: 'Revenue v2', status: 'archived', malicious: 'x', layout: { columns: 99, rowHeight: -5 } },
  });
  assert.equal(updated.name, 'Revenue v2');
  assert.equal(updated.status, 'archived');
  assert.equal('malicious' in updated, false);
  // Layout is clamped into bounds.
  assert.equal(updated.layout.columns, 24);
  assert.equal(updated.layout.rowHeight, 1);
});

test('publish transitions draft -> published; archived rejects; published is idempotent', async () => {
  const d = await dashboardService.createDashboard({ tenantId: TA, name: 'Revenue' });
  const connector = await createConnector(TA);
  await dashboardService.createWidget({ tenantId: TA, dashboardId: String(d._id), data: { name: 'Rows', type: 'table', datasetId: String(connector._id) } });
  const published = await dashboardService.publishDashboard({ tenantId: TA, dashboardId: String(d._id), actorId: 'u1' });
  assert.equal(published.status, 'published');

  const again = await dashboardService.publishDashboard({ tenantId: TA, dashboardId: String(d._id) });
  assert.equal(again.status, 'published');

  const archived = await dashboardService.updateDashboard({ tenantId: TA, dashboardId: String(d._id), patch: { status: 'archived' } });
  assert.equal(archived.status, 'archived');
  await assert.rejects(
    () => dashboardService.publishDashboard({ tenantId: TA, dashboardId: String(d._id) }),
    (e) => e.statusCode === 400,
  );
});

test('duplicate copies dashboard + widgets as a fresh draft with no shares', async () => {
  const d = await dashboardService.createDashboard({ tenantId: TA, name: 'Revenue', description: 'ops' });
  const connector = await createConnector(TA);
  await dashboardService.createWidget({
    tenantId: TA, dashboardId: String(d._id), actorId: 'u1',
    data: { name: 'Total', type: 'kpi', datasetId: String(connector._id), query: { metrics: [{ alias: 'total', op: 'count', field: 'amount' }] } },
  });
  const role = await Role.create({ tenantId: TA, name: 'Viewers' });
  await dashboardService.shareDashboard({ tenantId: TA, dashboardId: String(d._id), principalType: 'role', principalId: String(role._id) });

  const copy = await dashboardService.duplicateDashboard({ tenantId: TA, dashboardId: String(d._id), actorId: 'u1' });
  assert.equal(copy.name, 'Revenue (copy)');
  assert.equal(copy.status, 'draft');
  assert.deepEqual(copy.shares, [], 'copies never inherit share grants');

  const widgets = await widgetRepository.list({ tenantId: TA, dashboardId: String(copy._id) });
  assert.equal(widgets.total, 1);
  assert.equal(widgets.docs[0].name, 'Total');
  assert.notEqual(String(widgets.docs[0].dashboardId), String(d._id));
});

test('delete soft-deletes the dashboard and cascades to its widgets', async () => {
  const d = await dashboardService.createDashboard({ tenantId: TA, name: 'Revenue' });
  const connector = await createConnector(TA);
  await dashboardService.createWidget({
    tenantId: TA, dashboardId: String(d._id),
    data: { name: 'Total', type: 'table', datasetId: String(connector._id) },
  });

  await dashboardService.deleteDashboard({ tenantId: TA, dashboardId: String(d._id), actorId: 'u1' });

  assert.equal(await dashboardRepository.findById(String(d._id), { tenantId: TA }), null);
  assert.equal(await widgetRepository.countByDashboard(d._id), 0);

  // Rows are still physically present (soft delete).
  const raw = await Dashboard.withDeleted().findOne({ _id: d._id }).lean();
  assert.ok(raw.deletedAt);
  const rawWidgets = await Widget.withDeleted().find({ dashboardId: d._id }).lean();
  assert.ok(rawWidgets.every((w) => w.deletedAt));
});

test('share grants a revocable role entry and rejects duplicates', async () => {
  const d = await dashboardService.createDashboard({ tenantId: TA, name: 'Revenue' });
  const id = String(d._id);
  const role = await Role.create({ tenantId: TA, name: 'Viewers' });
  const other = await Role.create({ tenantId: 'tenant-other', name: 'Theirs' });

  const share = await dashboardService.shareDashboard({ tenantId: TA, dashboardId: id, actorId: 'u1', principalType: 'role', principalId: String(role._id) });
  assert.equal(share.principalId, String(role._id));
  assert.equal(share.level, 'view');
  assert.ok(share._id);

  await assert.rejects(
    () => dashboardService.shareDashboard({ tenantId: TA, dashboardId: id, principalType: 'role', principalId: String(other._id) }),
    (e) => e.statusCode === 400,
    'a role of another tenant cannot be a share principal',
  );
  await assert.rejects(
    () => dashboardService.shareDashboard({ tenantId: TA, dashboardId: id, principalType: 'role', principalId: String(role._id) }),
    (e) => e.statusCode === 409,
  );

  await dashboardService.revokeShare({ tenantId: TA, dashboardId: id, shareId: String(share._id), actorId: 'u1' });
  const after = await dashboardRepository.findById(id, { tenantId: TA });
  assert.equal(after.shares.length, 0);

  await assert.rejects(
    () => dashboardService.revokeShare({ tenantId: TA, dashboardId: id, shareId: new ObjectId().toString() }),
    (e) => e.statusCode === 404,
  );
});

async function createConnector(tenantId) {
  const connectorRepository = (await import('../../src/repositories/connector.repository.js')).default;
  return connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u1' });
}

test('publish rejects an empty dashboard (also via a status patch)', async () => {
  const d = await dashboardService.createDashboard({ tenantId: TA, name: 'Empty' });
  const isInvalid = (e) => e.statusCode === 400 && e.code === 'DASHBOARD_PUBLISH_INVALID';
  await assert.rejects(() => dashboardService.publishDashboard({ tenantId: TA, dashboardId: String(d._id) }), isInvalid);
  await assert.rejects(() => dashboardService.updateDashboard({ tenantId: TA, dashboardId: String(d._id), patch: { status: 'published' } }), isInvalid);
  const { dashboard } = await dashboardService.getDashboard({ tenantId: TA, dashboardId: String(d._id) });
  assert.equal(dashboard.status, 'draft');
});

test('publish returns per-widget errors for a missing dataset and a non-active metric', async () => {
  const d = await dashboardService.createDashboard({ tenantId: TA, name: 'Broken' });
  const connector = await createConnector(TA);
  const ok = await dashboardService.createWidget({ tenantId: TA, dashboardId: String(d._id), data: { name: 'Rows', type: 'table', datasetId: String(connector._id) } });
  // Simulate drift after save: dataset deleted on one widget, a draft metric ref on another.
  const gone = await widgetRepository.create({ tenantId: TA, dashboardId: d._id, name: 'Gone', type: 'table', datasetId: new ObjectId() });
  const draft = await widgetRepository.create({
    tenantId: TA, dashboardId: d._id, name: 'Draft metric', type: 'kpi', datasetId: connector._id,
    query: { metrics: [{ ref: 'metric:not_active' }] },
  });
  const err = await dashboardService.publishDashboard({ tenantId: TA, dashboardId: String(d._id) }).catch((e) => e);
  assert.equal(err.code, 'DASHBOARD_PUBLISH_INVALID');
  const ids = new Set(err.errors.map((e) => e.widgetId));
  assert.ok(ids.has(String(gone._id)));
  assert.ok(ids.has(String(draft._id)));
  assert.ok(!ids.has(String(ok._id)));
  assert.match(err.errors.find((e) => e.widgetId === String(draft._id)).message, /not an active metric/);
});

test('a widget cannot be saved with a draft/unknown metric reference', async () => {
  const d = await dashboardService.createDashboard({ tenantId: TA, name: 'M' });
  const connector = await createConnector(TA);
  await assert.rejects(
    () => dashboardService.createWidget({ tenantId: TA, dashboardId: String(d._id), data: { name: 'K', type: 'kpi', datasetId: String(connector._id), query: { metrics: [{ ref: 'metric:not_active' }] } } }),
    (e) => e.statusCode === 400 && /not an active metric/.test(JSON.stringify(e.errors)),
  );
});
