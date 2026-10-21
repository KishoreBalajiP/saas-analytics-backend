/**
 * Tenant import round trip (roadmap 2.9): export -> import -> equal counts
 * and content checksums, with every id remapped consistently. Also proves
 * that an archive is treated as untrusted input (checksums, manifest
 * structure, record ownership) and that a failed import leaves nothing.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';

import { startMongo, stopMongo, resetMongo, getMongoUri } from '../helpers/mongo.js';
import queueService from '../../src/services/queue.service.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import {
  openArchive,
  verifyArchive,
  importTenant,
  verifyImport,
  rollbackImport,
} from '../../src/services/tenantImport.service.js';
import { EXPORTED, collectionNameOf } from '../../src/services/tenantDataCatalogue.js';
import { sha256Hex, serializeDocument } from '../../src/services/tenantArchive.js';
import { seededTenant, exportToFile, countTenantDocuments } from './helpers.js';

const { ObjectId } = mongoose.Types;
let workRoot;
let scratch;

before(async () => {
  await startMongo();
  workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tenant-import-test-'));
});
beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
});
after(async () => {
  if (scratch) await scratch.close().catch(() => null);
  await fsp.rm(workRoot, { recursive: true, force: true });
  await queueService.closeAll();
  await stopMongo();
});

const MODELS = EXPORTED.map((e) => e.model);

async function scratchConnection(name) {
  if (scratch) await scratch.close();
  const uri = `${getMongoUri().replace(/\/$/, '')}/${name}`;
  scratch = mongoose.createConnection(uri);
  await scratch.asPromise();
  return scratch;
}

async function exportOpened(tenantId) {
  const { file } = await exportToFile(tenantId, path.join(workRoot, String(Date.now())));
  return { file, ...(await openArchive({ source: file, workDir: workRoot })) };
}

test('export -> clone import reproduces every collection with remapped ids', async () => {
  const source = await seededTenant('RT');
  const opened = await exportOpened(source.tenantId);
  // Taken after the export (which audits itself on the source tenant).
  const before = await countTenantDocuments(source.tenantId, MODELS);
  try {
    const integrity = await verifyArchive({ dir: opened.dir, manifest: opened.manifest });
    assert.equal(integrity.ok, true, JSON.stringify(integrity.files.filter((f) => !f.ok)));

    const result = await importTenant({ dir: opened.dir, manifest: opened.manifest, mode: 'clone' });
    assert.notEqual(result.tenantId, source.tenantId, 'the clone is a new tenant');
    const verification = await verifyImport({ manifest: opened.manifest, result });
    assert.equal(verification.ok, true, JSON.stringify(verification.collections.filter((c) => !c.ok)));
    assert.equal(verification.collections.length, EXPORTED.length);
    assert.ok(verification.datasets.length === 2 && verification.datasets.every((d) => d.ok));

    // Same counts as the source; the source tenant is untouched.
    const cloned = await countTenantDocuments(result.tenantId, MODELS.filter((m) => m !== 'RolePermission'));
    for (const record of opened.manifest.collections) {
      if (record.model === 'RolePermission') continue;
      assert.equal(cloned[record.model], record.count, `${record.model} restored count`);
    }
    assert.deepEqual(await countTenantDocuments(source.tenantId, MODELS), before);

    // Ids are remapped consistently across references.
    const map = (id) => result.idMap.get(String(id)).toHexString();
    const db = (model) => mongoose.model(model).collection;
    const widget = await db('Widget').findOne({ tenantId: result.tenantId });
    assert.equal(String(widget._id), map(source.ids.widget));
    assert.equal(String(widget.dashboardId), map(source.ids.dashboard));
    assert.ok(widget.dashboardId instanceof ObjectId || widget.dashboardId._bsontype === 'ObjectId', 'ObjectId references stay ObjectIds');
    assert.deepEqual(widget.query.connectorIds, [map(source.ids.connectorA)], 'string references are remapped');
    const dashboard = await db('Dashboard').findOne({ tenantId: result.tenantId });
    assert.equal(dashboard.layout[0].widgetId, map(source.ids.widget), 'nested references are remapped');
    const connector = await db('Connector').findOne({ _id: new ObjectId(map(source.ids.connectorA)) });
    assert.equal(connector.currentSyncRunId, map(source.ids.syncRun));
    assert.equal(connector.config, null, 'credentials are not restored');
    const report = await db('Report').findOne({ tenantId: result.tenantId });
    assert.ok(report.runs[0].resultKey.includes(result.tenantId), 'ids inside strings are remapped');
    const audit = await db('AuditLog').findOne({ tenantId: result.tenantId, resourceType: 'dashboard' });
    assert.equal(audit.resourceId, map(source.ids.dashboard));
    // Dataset rows: references remapped, the customer's data untouched.
    const row = await db('ConnectorRow').findOne({ tenantId: result.tenantId, sourceRowId: 'e1' });
    assert.equal(String(row.connectorId), map(source.ids.connectorB));
    assert.equal(row.data.userRef, String(source.ids.ssoUser), 'dataset values are never rewritten');
    // Role grants follow the remapped roles; platform permission ids stay.
    const roles = await db('Role').find({ tenantId: result.tenantId }).toArray();
    const grants = await db('RolePermission').find({ roleId: { $in: roles.map((r) => String(r._id)) } }).toArray();
    const sourceRoles = await db('Role').find({ tenantId: source.tenantId }).toArray();
    const sourceGrants = await db('RolePermission').find({ roleId: { $in: sourceRoles.map((r) => String(r._id)) } }).toArray();
    assert.equal(grants.length, sourceGrants.length);
    assert.deepEqual(new Set(grants.map((g) => g.permissionId)), new Set(sourceGrants.map((g) => g.permissionId)));

    // No document of the clone reuses a source id.
    for (const model of MODELS) {
      const ids = (await db(model).find(model === 'Tenant' ? { _id: new ObjectId(result.tenantId) } : { tenantId: result.tenantId }).toArray()).map((d) => String(d._id));
      const sourceIds = new Set((await db(model).find(model === 'Tenant' ? { _id: new ObjectId(source.tenantId) } : { tenantId: source.tenantId }).toArray()).map((d) => String(d._id)));
      assert.ok(ids.every((id) => !sourceIds.has(id)), `${model} ids are new`);
    }

    // The clone is inert and keeps globally unique keys unique.
    const tenant = await db('Tenant').findOne({ _id: new ObjectId(result.tenantId) });
    const sourceTenant = await db('Tenant').findOne({ _id: new ObjectId(source.tenantId) });
    assert.equal(tenant.status, 'disabled');
    assert.match(tenant.disabledReason, new RegExp(opened.manifest.exportId));
    assert.notEqual(tenant.slug, sourceTenant.slug);
    assert.equal(tenant.ownerId, map(sourceTenant.ownerId));
    const payment = await db('PaymentTransaction').findOne({ tenantId: result.tenantId });
    assert.match(payment.providerOrderId, /:restore:/);
    const sso = await db('User').findOne({ _id: new ObjectId(map(source.ids.ssoUser)) });
    assert.equal(sso.ssoSubject, null);
    assert.equal(sso.passwordHash, null);

    // Rollback removes the clone completely.
    await rollbackImport({ result });
    const left = await countTenantDocuments(result.tenantId, MODELS);
    assert.ok(Object.values(left).every((n) => n === 0), JSON.stringify(left));
  } finally {
    await opened.cleanup();
  }
});

test('preserve import into an empty scratch database keeps ids and builds indexes; a second one is refused', async () => {
  const source = await seededTenant('PR');
  const opened = await exportOpened(source.tenantId);
  try {
    const conn = await scratchConnection(`scratch_${Date.now()}`);
    const result = await importTenant({ dir: opened.dir, manifest: opened.manifest, connection: conn, mode: 'preserve', buildIndexes: true });
    assert.equal(result.tenantId, source.tenantId);
    const verification = await verifyImport({ manifest: opened.manifest, result, connection: conn });
    assert.equal(verification.ok, true, JSON.stringify(verification.collections.filter((c) => !c.ok)));
    const widget = await conn.collection(collectionNameOf('Widget')).findOne({});
    assert.equal(String(widget._id), String(source.ids.widget));
    const indexes = await conn.collection(collectionNameOf('User')).indexes();
    assert.ok(indexes.some((i) => i.unique && i.key.tenantId === 1 && i.key.email === 1), 'model indexes exist in the scratch database');

    await assert.rejects(
      () => importTenant({ dir: opened.dir, manifest: opened.manifest, connection: conn, mode: 'preserve' }),
      (err) => err.code === 'IMPORT_TARGET_NOT_EMPTY',
    );
    // The application database was not written to.
    assert.equal(await mongoose.model('Tenant').collection.countDocuments({}), 1);
  } finally {
    await opened.cleanup();
  }
});

test('a failed import rolls back everything it wrote', async () => {
  const source = await seededTenant('RB');
  const opened = await exportOpened(source.tenantId);
  try {
    const conn = await scratchConnection(`scratch_rb_${Date.now()}`);
    // A record with the archive's widget id already exists (another tenant).
    await conn.collection(collectionNameOf('Widget')).insertOne({ _id: source.ids.widget, tenantId: 'someone-else' });
    await assert.rejects(
      () => importTenant({ dir: opened.dir, manifest: opened.manifest, connection: conn, mode: 'preserve' }),
      (err) => err.code === 'IMPORT_DUPLICATE_KEY',
    );
    for (const entry of EXPORTED) {
      const filter = entry.scope === 'self' ? { _id: new ObjectId(source.tenantId) } : entry.scope === 'tenant' ? { tenantId: source.tenantId } : {};
      assert.equal(await conn.collection(collectionNameOf(entry.model)).countDocuments(filter), 0, `${entry.model} rolled back`);
    }
    assert.equal(await conn.collection(collectionNameOf('Widget')).countDocuments({}), 1, 'pre-existing data is untouched');
  } finally {
    await opened.cleanup();
  }
});

test('tampered archives are rejected before anything is written', async () => {
  const victim = await seededTenant('VI');
  const source = await seededTenant('TA');
  const opened = await exportOpened(source.tenantId);
  try {
    const dashboards = opened.manifest.collections.find((c) => c.model === 'Dashboard');
    const file = path.join(opened.dir, dashboards.file);

    // 1. Checksum mismatch is detected.
    const original = await fsp.readFile(file);
    const smuggled = serializeDocument({ _id: new ObjectId(), tenantId: victim.tenantId, name: 'smuggled' });
    await fsp.writeFile(file, Buffer.concat([original, Buffer.from(`${smuggled}\n`)]));
    const integrity = await verifyArchive({ dir: opened.dir, manifest: opened.manifest });
    assert.equal(integrity.ok, false);
    assert.equal(integrity.files.find((f) => f.file === dashboards.file).ok, false);

    // 2. Even with a manifest rewritten to match, a record of another
    //    workspace is refused and nothing is written.
    const forged = structuredClone(opened.manifest);
    const entry = forged.collections.find((c) => c.model === 'Dashboard');
    const bytes = await fsp.readFile(file);
    entry.count += 1;
    entry.bytes = bytes.length;
    entry.sha256 = sha256Hex(bytes);
    const tenantsBefore = await mongoose.model('Tenant').collection.countDocuments({});
    const victimDashboards = await mongoose.model('Dashboard').collection.countDocuments({ tenantId: victim.tenantId });
    await assert.rejects(() => importTenant({ dir: opened.dir, manifest: forged, mode: 'clone' }), (err) => err.code === 'ARCHIVE_FOREIGN_RECORD');
    await assert.rejects(() => importTenant({ dir: opened.dir, manifest: forged, mode: 'preserve' }), (err) => err.code === 'ARCHIVE_FOREIGN_RECORD');
    assert.equal(await mongoose.model('Tenant').collection.countDocuments({}), tenantsBefore);
    assert.equal(await mongoose.model('Dashboard').collection.countDocuments({ tenantId: victim.tenantId }), victimDashboards);

    // 3. Unlisted files and counts that do not match are refused.
    await fsp.writeFile(file, original);
    await fsp.writeFile(path.join(opened.dir, 'collections', 'sessions.jsonl'), '{}\n');
    assert.deepEqual((await verifyArchive({ dir: opened.dir, manifest: opened.manifest })).unexpected, ['collections/sessions.jsonl']);
    const miscounted = structuredClone(opened.manifest);
    miscounted.collections.find((c) => c.model === 'Dashboard').count += 5;
    await assert.rejects(() => importTenant({ dir: opened.dir, manifest: miscounted, mode: 'clone' }), (err) => err.code === 'ARCHIVE_COUNT_MISMATCH');
  } finally {
    await opened.cleanup();
  }
});

test('openArchive validates the manifest of an extracted directory', async () => {
  const dir = await fsp.mkdtemp(path.join(workRoot, 'bad-'));
  await assert.rejects(() => openArchive({ source: dir }), (err) => err.code === 'ARCHIVE_MANIFEST_INVALID');
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ format: 'analivo.tenant-export', formatVersion: 99 }));
  await assert.rejects(() => openArchive({ source: dir }), (err) => err.code === 'ARCHIVE_VERSION_UNSUPPORTED');
  await assert.rejects(() => openArchive({ source: path.join(dir, 'missing.tar.gz') }), (err) => err.code === 'ARCHIVE_SOURCE_MISSING');
  const notTar = path.join(dir, 'x.tar.gz');
  await fsp.writeFile(notTar, 'not a tarball');
  await assert.rejects(() => openArchive({ source: notTar, workDir: workRoot }), (err) => err.code === 'ARCHIVE_UNREADABLE');
});
