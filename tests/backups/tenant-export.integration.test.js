/**
 * Tenant data export (roadmap 2.9) over real HTTP.
 *
 * Exit criteria proven here:
 *   - the archive contains every exported tenant collection with counts and
 *     checksums that match the database, and nothing from another tenant;
 *   - secrets (password hashes, connector credentials, secret settings,
 *     API key / embed / invitation token hashes) never reach the archive;
 *   - the download is permission-gated (workspace + platform surfaces,
 *     tenant isolation, admin tenant scope) and expires;
 *   - one export in flight per tenant, a daily request limit, abandoned and
 *     expired exports are swept, everything is audited, and the requester is
 *     emailed without a link.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';

import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import * as emailService from '../../src/services/email.service.js';
import * as storageService from '../../src/services/storage.service.js';
import tenantExportService from '../../src/services/tenantExport.service.js';
import tenantExportRepository from '../../src/repositories/tenantExport.repository.js';
import { TenantExport } from '../../src/models/TenantExport.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { Tenant } from '../../src/models/Tenant.js';
import { EXPORTED, EXCLUDED, selectionFilter, collectionNameOf } from '../../src/services/tenantDataCatalogue.js';
import { CollectionDigest, parseDocument, sha256Hex } from '../../src/services/tenantArchive.js';
import { extractTarGz } from '../../src/utils/tarArchive.js';
import { onboard, member, platformAdmin, seedTenantData, waitForExport, SECRET_MARKERS } from './fixtures.js';

let workRoot;

before(async () => {
  await startMongo();
  await startHttp();
  workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tenant-export-test-'));
});
beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  await cacheService.flushAll();
});
after(async () => {
  emailService.stopCapture();
  await fsp.rm(workRoot, { recursive: true, force: true });
  await stopHttp();
  await stopMongo();
});

/* -------------------------------- helpers -------------------------------- */

async function requestAndWait(auth) {
  const res = await api('/api/v1/workspace/data-exports', { method: 'POST', headers: auth });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.equal(res.json.data.status, 'queued');
  assert.match(res.json.data.exportId, /^tex_[0-9a-z]{26}$/);
  return waitForExport(`/api/v1/workspace/data-exports/${res.json.data.exportId}`, auth);
}

/** Download through a minted link and extract the archive. */
async function downloadAndExtract(linkPath, auth) {
  const link = await api(linkPath, { method: 'POST', headers: auth });
  assert.equal(link.status, 200, JSON.stringify(link.json));
  assert.equal(link.headers.get('cache-control'), 'no-store');
  const { url, sha256, fileName } = link.json.data;
  assert.match(url, /\/api\/v1\/data-exports\/download\/v1\./);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gzip');
  assert.match(res.headers.get('content-disposition'), new RegExp(`attachment; filename="${fileName.replace(/\./g, '\\.')}"`));
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(sha256Hex(bytes), sha256, 'downloaded bytes match the recorded archive checksum');
  const dir = await fsp.mkdtemp(path.join(workRoot, 'x-'));
  const file = path.join(dir, fileName);
  await fsp.writeFile(file, bytes);
  const out = path.join(dir, 'out');
  const names = await extractTarGz({ file, destDir: out });
  const manifest = JSON.parse(await fsp.readFile(path.join(out, 'manifest.json'), 'utf8'));
  return { dir: out, names, manifest, url, link: link.json.data };
}

async function readAll(dir, names) {
  let text = '';
  for (const name of names) text += await fsp.readFile(path.join(dir, name), 'utf8');
  return text;
}

/* --------------------------------- tests --------------------------------- */

test('an owner export contains every tenant collection with matching counts and checksums, and nothing else', async () => {
  const a = await onboard('Alpha');
  const b = await onboard('Beta');
  await seedTenantData(a.tenantId, { ownerId: a.ownerId, tag: 'AAA' });
  const bIds = await seedTenantData(b.tenantId, { ownerId: b.ownerId, tag: 'BBB' });
  const sink = [];
  emailService.captureInto(sink);

  const requestedAt = new Date();
  const done = await requestAndWait(a.auth);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.equal(done.downloadable, true);
  assert.ok(done.sizeBytes > 0);
  assert.match(done.sha256, /^[0-9a-f]{64}$/);
  assert.ok(new Date(done.expiresAt) > new Date());

  const { dir, names, manifest } = await downloadAndExtract(`/api/v1/workspace/data-exports/${done.exportId}/download-url`, a.auth);
  assert.equal(manifest.format, 'analivo.tenant-export');
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.tenant.id, a.tenantId);

  // Every exported catalogue collection is present, non-empty for this
  // seeded tenant, and its count equals what the database holds.
  const roleIds = (await mongoose.model('Role').collection.find({ tenantId: a.tenantId }).toArray()).map((r) => String(r._id));
  assert.deepEqual(manifest.collections.map((c) => c.model), EXPORTED.map((e) => e.model));
  // The audit and access trails keep growing while and after the export runs
  // (completion, link and download events): for them, everything recorded
  // before the request must be in the archive and nothing else may be.
  const appendOnly = new Set(['AuditLog', 'AccessLog']);
  for (const entry of EXPORTED) {
    const record = manifest.collections.find((c) => c.model === entry.model);
    const collection = mongoose.model(entry.model).collection;
    const filter = selectionFilter(entry, { tenantId: a.tenantId, roleIds });
    const dbCount = await collection.countDocuments(filter);
    assert.ok(dbCount > 0, `${entry.model} is seeded for the tenant`);
    if (appendOnly.has(entry.model)) {
      const exportedIds = new Set((await fsp.readFile(path.join(dir, record.file), 'utf8')).split('\n').filter(Boolean).map((l) => String(parseDocument(l)._id)));
      const before = await collection.find({ ...filter, occurredAt: { $lt: requestedAt } }).toArray();
      assert.ok(before.length > 0);
      for (const doc of before) assert.ok(exportedIds.has(String(doc._id)), `${entry.model} record from before the request is exported`);
      for (const id of exportedIds) assert.ok(await collection.findOne({ ...filter, _id: new mongoose.Types.ObjectId(id) }), `${entry.model} exported record exists for the tenant`);
    } else {
      assert.equal(record.count, dbCount, `${entry.model} count`);
    }
    assert.equal(record.collection, collectionNameOf(entry.model));

    // File checksum and size.
    const bytes = await fsp.readFile(path.join(dir, record.file));
    assert.equal(bytes.length, record.bytes, `${entry.model} bytes`);
    assert.equal(sha256Hex(bytes), record.sha256, `${entry.model} sha256`);

    // Content checksum recomputed from the lines; every line is this tenant's.
    const lines = bytes.toString('utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, record.count);
    const digest = new CollectionDigest({ includeId: entry.idReferenced });
    for (const line of lines) {
      const doc = parseDocument(line);
      if (entry.scope === 'tenant') assert.equal(doc.tenantId, a.tenantId, `${entry.model} record belongs to the tenant`);
      if (entry.scope === 'self') assert.equal(String(doc._id), a.tenantId);
      if (entry.scope === 'roles') assert.ok(roleIds.includes(String(doc.roleId)));
      digest.add(doc);
    }
    assert.equal(digest.digest(), record.contentSha256, `${entry.model} content checksum`);
  }

  // Datasets: one CSV per connector, formula-escaped, CRLF, with a header.
  assert.equal(manifest.datasets.length, 2);
  assert.equal(manifest.orphanDatasetRows, 1);
  const sales = manifest.datasets.find((d) => d.name === 'Sales AAA');
  assert.equal(sales.rows, 3);
  const csv = await fsp.readFile(path.join(dir, sales.file), 'utf8');
  assert.equal(sha256Hex(Buffer.from(csv)), sales.sha256);
  const csvLines = csv.split('\r\n').filter(Boolean);
  assert.equal(csvLines[0], 'region,revenue,note,closedAt,extra');
  assert.ok(csvLines.some((l) => l.includes("'=SUM(A1:A9)")), 'formula cells are neutralised');
  assert.ok(csvLines.some((l) => l.includes('"plain, with ""quotes"""')), 'RFC 4180 quoting');

  // Exclusions are explicit and cover credentials.
  const excluded = manifest.excluded.map((e) => e.model);
  for (const model of ['Session', 'ApiKey', 'EmbedToken', 'TenantInvitation', 'PasswordResetToken', 'EmailVerificationToken', 'JobRun']) {
    assert.ok(excluded.includes(model), `${model} is explicitly excluded`);
  }
  assert.equal(manifest.excluded.length, EXCLUDED.length);

  // Nothing from tenant B, and no secret.
  const everything = await readAll(dir, names);
  assert.ok(!everything.includes(b.tenantId), 'no reference to the other tenant');
  for (const id of Object.values(bIds)) assert.ok(!everything.includes(String(id)), 'no record of the other tenant');
  assert.ok(!everything.includes('BBB'), 'no content of the other tenant');
  for (const marker of SECRET_MARKERS) assert.ok(!everything.includes(marker), `secret ${marker} is not exported`);
  const owner = await mongoose.model('User').collection.findOne({ _id: new mongoose.Types.ObjectId(a.ownerId) });
  assert.ok(owner.passwordHash && !everything.includes(owner.passwordHash), 'password hashes are not exported');
  assert.ok(!everything.includes('SECRET-PASSWORD-HASH'));
  // Redactions are documented in the manifest.
  assert.ok(manifest.collections.find((c) => c.model === 'Connector').redactions.length >= 2);

  // The row records the summary; the requester was emailed without a link.
  const row = await TenantExport.findOne({ exportId: done.exportId }).lean();
  assert.equal(row.summary.collections, EXPORTED.length);
  assert.equal(row.inFlight, undefined, 'the in-flight slot is released');
  const mail = sink.find((m) => m.to === a.ownerEmail);
  assert.ok(mail, 'the requester is notified');
  assert.match(mail.text, new RegExp(done.exportId));
  assert.equal(mail.subject, 'Your workspace data export is ready', 'rendered from the tenant.data_export_ready template');
  assert.match(mail.text, /\/settings to download it before \d{4}-/);
  assert.ok(!/data-exports\/download|v1\.[A-Za-z0-9_-]{20,}/.test(mail.text), 'the email carries no download link');

  // Audit trail.
  const actions = (await AuditLog.find({ tenantId: a.tenantId, module: 'data_exports' }).lean()).map((r) => r.action);
  for (const action of ['tenant_export.requested', 'tenant_export.completed', 'tenant_export.download_issued', 'tenant_export.downloaded']) {
    assert.ok(actions.includes(action), `${action} is audited`);
  }
  emailService.stopCapture();
});

test('the workspace export surface is permission-gated and tenant-isolated', async () => {
  const a = await onboard('Alpha');
  const b = await onboard('Beta');
  const done = await requestAndWait(a.auth);
  assert.equal(done.status, 'completed');
  const exportPath = `/api/v1/workspace/data-exports/${done.exportId}`;

  // Unauthenticated.
  assert.equal((await api('/api/v1/workspace/data-exports')).status, 401);
  assert.equal((await api(`${exportPath}/download-url`, { method: 'POST' })).status, 401);

  // Members without the permission (no role, Viewer, and Admin: Owner-only by default).
  for (const role of [null, 'Viewer', 'Admin']) {
    const auth = await member(a.tenantId, role);
    assert.equal((await api('/api/v1/workspace/data-exports', { headers: auth })).status, 403, `${role} cannot list`);
    assert.equal((await api('/api/v1/workspace/data-exports', { method: 'POST', headers: auth })).status, 403, `${role} cannot request`);
    assert.equal((await api(exportPath, { headers: auth })).status, 403, `${role} cannot read`);
    assert.equal((await api(`${exportPath}/download-url`, { method: 'POST', headers: auth })).status, 403, `${role} cannot download`);
  }

  // Another workspace's owner cannot see or download it (404), even when
  // naming the other tenant in the header.
  const other = await api(exportPath, { headers: b.auth });
  assert.equal(other.status, 404);
  assert.equal(other.json.code, 'EXPORT_NOT_FOUND');
  assert.equal((await api(`${exportPath}/download-url`, { method: 'POST', headers: b.auth })).status, 404);
  const spoof = await api(exportPath, { headers: { ...b.auth, 'X-Tenant-Id': a.tenantId } });
  assert.equal(spoof.status, 403);
  const listB = await api('/api/v1/workspace/data-exports', { headers: b.auth });
  assert.equal(listB.status, 200);
  assert.deepEqual(listB.json.data, []);

  // Listing for the owner (array in data, pagination in meta).
  const list = await api('/api/v1/workspace/data-exports', { headers: a.auth });
  assert.equal(list.status, 200);
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.meta.total, 1);
  assert.equal(list.json.data[0].exportId, done.exportId);
  assert.equal(list.json.data[0].storageKey, undefined, 'storage keys are never exposed');

  // Invalid ids are validated.
  assert.equal((await api('/api/v1/workspace/data-exports/not-an-id', { headers: a.auth })).status, 422);
});

test('download links expire, are bound to their export, and stop working when the archive expires', async () => {
  const a = await onboard('Alpha');
  const done = await requestAndWait(a.auth);
  const linkPath = `/api/v1/workspace/data-exports/${done.exportId}/download-url`;
  const { link } = await downloadAndExtract(linkPath, a.auth);
  assert.ok(new Date(link.expiresAt).getTime() - Date.now() <= 300 * 1000 + 1000, 'links live minutes');

  // A forged or altered token is refused.
  const base = link.url.slice(0, link.url.indexOf('/download/') + '/download/'.length);
  const token = link.url.slice(base.length);
  const [v, payload] = token.split('.');
  const forged = `${v}.${payload}.${'A'.repeat(43)}`;
  const forgedRes = await fetch(`${base}${forged}`);
  assert.equal(forgedRes.status, 401);
  assert.equal((await forgedRes.json()).code, 'DOWNLOAD_LINK_INVALID');
  assert.equal((await fetch(`${base}garbage`)).status, 401);

  // An expired link is refused.
  const expired = tenantExportService.signDownloadToken({ exportId: done.exportId, tenantId: a.tenantId, expiresAt: new Date(Date.now() - 1000), actor: { type: 'user', id: a.ownerId } });
  const expiredRes = await fetch(`${base}${expired}`);
  assert.equal(expiredRes.status, 410);
  assert.equal((await expiredRes.json()).code, 'DOWNLOAD_LINK_EXPIRED');

  // A valid signature for an export of another tenant id finds nothing.
  const wrongTenant = tenantExportService.signDownloadToken({ exportId: done.exportId, tenantId: new mongoose.Types.ObjectId().toHexString(), expiresAt: new Date(Date.now() + 60000), actor: { type: 'user', id: a.ownerId } });
  assert.equal((await fetch(`${base}${wrongTenant}`)).status, 404);

  // Once the archive expires: no new links, existing links stop working.
  const live = tenantExportService.signDownloadToken({ exportId: done.exportId, tenantId: a.tenantId, expiresAt: new Date(Date.now() + 60000), actor: { type: 'user', id: a.ownerId } });
  await TenantExport.updateOne({ exportId: done.exportId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const refused = await api(linkPath, { method: 'POST', headers: a.auth });
  assert.equal(refused.status, 410);
  assert.equal(refused.json.code, 'EXPORT_EXPIRED');
  assert.equal((await fetch(`${base}${live}`)).status, 410);
  const status = await api(`/api/v1/workspace/data-exports/${done.exportId}`, { headers: a.auth });
  assert.equal(status.json.data.status, 'expired');
  assert.equal(status.json.data.downloadable, false);

  // The sweep deletes the archive and marks the row expired.
  const row = await TenantExport.findOne({ exportId: done.exportId }).lean();
  assert.equal(await storageService.exists(row.storageKey), true);
  const swept = await tenantExportService.sweep();
  assert.equal(swept.expired, 1);
  assert.equal(await storageService.exists(row.storageKey), false, 'the archive is deleted from storage');
  const after = await TenantExport.findOne({ exportId: done.exportId }).lean();
  assert.equal(after.status, 'expired');
  assert.equal(after.storageKey, undefined);
  assert.ok(await AuditLog.findOne({ tenantId: a.tenantId, action: 'tenant_export.expired' }));
});

test('an export that is not ready cannot be downloaded', async () => {
  const a = await onboard('Alpha');
  const row = await tenantExportRepository.create({
    exportId: 'tex_01jabcdefghjkmnpqrstvwxyz0',
    tenantId: a.tenantId,
    origin: 'tenant',
    requestedBy: { type: 'user', id: a.ownerId },
    leaseUntil: new Date(Date.now() + 60000),
  });
  const res = await api(`/api/v1/workspace/data-exports/${row.exportId}/download-url`, { method: 'POST', headers: a.auth });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'EXPORT_NOT_READY');
});

test('one export in flight per workspace, a daily limit, and abandoned exports are released', async () => {
  const a = await onboard('Alpha');
  // An export already queued blocks a second request atomically.
  const queued = await tenantExportRepository.create({
    exportId: 'tex_01jabcdefghjkmnpqrstvwxyz1',
    tenantId: a.tenantId,
    origin: 'tenant',
    requestedBy: { type: 'user', id: a.ownerId },
    leaseUntil: new Date(Date.now() - 1000),
  });
  const blocked = await api('/api/v1/workspace/data-exports', { method: 'POST', headers: a.auth });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.code, 'EXPORT_IN_PROGRESS');
  assert.equal(blocked.json.errors[0].message, queued.exportId);

  // The sweep fails the export nobody picked up, which releases the slot.
  const swept = await tenantExportService.sweep();
  assert.equal(swept.abandoned, 1);
  const failed = await TenantExport.findOne({ exportId: queued.exportId }).lean();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'EXPORT_NOT_STARTED');

  const first = await requestAndWait(a.auth);
  assert.equal(first.status, 'completed');
  const second = await requestAndWait(a.auth);
  assert.equal(second.status, 'completed');
  // The abandoned one counts too: three requests in 24 hours.
  const limited = await api('/api/v1/workspace/data-exports', { method: 'POST', headers: a.auth });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, 'EXPORT_RATE_LIMITED');
});

test('the worker skips replays and does not build a tenant-requested export for an inactive workspace', async () => {
  const a = await onboard('Alpha');
  const done = await requestAndWait(a.auth);
  const replay = await tenantExportService.processExport({ exportId: done.exportId });
  assert.equal(replay.skipped, true);
  assert.equal(replay.status, 'completed');

  const row = await tenantExportRepository.create({
    exportId: 'tex_01jabcdefghjkmnpqrstvwxyz2',
    tenantId: a.tenantId,
    origin: 'tenant',
    requestedBy: { type: 'user', id: a.ownerId },
    leaseUntil: new Date(Date.now() + 60000),
  });
  await Tenant.updateOne({ _id: a.tenantId }, { $set: { status: 'suspended' } });
  const result = await tenantExportService.processExport({ exportId: row.exportId });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'TENANT_NOT_ACTIVE');
  assert.equal((await TenantExport.findOne({ exportId: row.exportId }).lean()).status, 'failed');
});

test('platform admins export a tenant with a reason, within their tenant scope; members cannot download it', async () => {
  const a = await onboard('Alpha');
  const b = await onboard('Beta');
  await seedTenantData(a.tenantId, { ownerId: a.ownerId, tag: 'AAA' });
  const viewer = await platformAdmin(['iam.tenants.view']);
  const exporter = await platformAdmin(['iam.tenants.view', 'iam.tenants.export']);
  const scopedToB = await platformAdmin(['iam.tenants.view', 'iam.tenants.export'], { tenantScope: b.tenantId });
  const base = `/api/v1/tenants/${a.tenantId}/data-exports`;

  // A tenant user token cannot use the platform surface.
  assert.equal((await api(base, { headers: a.auth })).status, 401);
  // View-only admins can list but not export.
  assert.equal((await api(base, { headers: viewer.auth })).status, 200);
  assert.equal((await api(base, { method: 'POST', headers: viewer.auth, body: { reason: 'support ticket 42' } })).status, 403);
  // A reason is mandatory.
  assert.equal((await api(base, { method: 'POST', headers: exporter.auth, body: {} })).status, 422);
  // Scoped admins cannot reach another tenant.
  assert.equal((await api(base, { method: 'POST', headers: scopedToB.auth, body: { reason: 'support ticket 42' } })).status, 403);
  assert.equal((await api(base, { headers: scopedToB.auth })).status, 403);

  const created = await api(base, { method: 'POST', headers: exporter.auth, body: { reason: 'Portability request #42' } });
  assert.equal(created.status, 202, JSON.stringify(created.json));
  assert.equal(created.json.data.origin, 'platform');
  const done = await waitForExport(`${base}/${created.json.data.exportId}`, exporter.auth);
  assert.equal(done.status, 'completed');
  assert.equal(done.requestedBy.email, exporter.email);

  // The admin can download it; a scoped admin of another tenant cannot.
  const { manifest } = await downloadAndExtract(`${base}/${done.exportId}/download-url`, exporter.auth);
  assert.equal(manifest.origin, 'platform');
  assert.equal((await api(`${base}/${done.exportId}/download-url`, { method: 'POST', headers: scopedToB.auth })).status, 403);
  assert.equal((await api(`/api/v1/tenants/${b.tenantId}/data-exports/${done.exportId}`, { headers: exporter.auth })).status, 404, 'export ids are tenant-scoped');

  // The workspace sees that support exported its data, but not who, and
  // cannot download it.
  const list = await api('/api/v1/workspace/data-exports', { headers: a.auth });
  const seen = list.json.data.find((e) => e.exportId === done.exportId);
  assert.equal(seen.origin, 'platform');
  assert.deepEqual(seen.requestedBy, { type: 'admin', id: null, email: null, display: 'Platform support' });
  assert.equal(seen.reason, null);
  assert.equal(seen.downloadable, false);
  const denied = await api(`/api/v1/workspace/data-exports/${done.exportId}/download-url`, { method: 'POST', headers: a.auth });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'EXPORT_DOWNLOAD_FORBIDDEN');

  const audit = await AuditLog.findOne({ tenantId: a.tenantId, action: 'tenant_export.requested', actorType: 'admin' }).lean();
  assert.equal(audit.reason, 'Portability request #42');
});

test('platform admins can export a suspended workspace; its members cannot request one', async () => {
  const a = await onboard('Alpha');
  const exporter = await platformAdmin(['iam.tenants.view', 'iam.tenants.export']);
  await Tenant.updateOne({ _id: a.tenantId }, { $set: { status: 'suspended' } });
  // A workspace-originated request for an inactive workspace is refused by
  // the service even if a session were still accepted.
  await assert.rejects(
    () => tenantExportService.requestExport({ tenantId: a.tenantId, origin: 'tenant', actor: { type: 'user', id: a.ownerId } }),
    (err) => err.statusCode === 403 && err.code === 'TENANT_NOT_ACTIVE',
  );
  const base = `/api/v1/tenants/${a.tenantId}/data-exports`;
  const created = await api(base, { method: 'POST', headers: exporter.auth, body: { reason: 'Closure portability request' } });
  assert.equal(created.status, 202, JSON.stringify(created.json));
  const done = await waitForExport(`${base}/${created.json.data.exportId}`, exporter.auth);
  assert.equal(done.status, 'completed');
  // Unknown tenants are refused.
  const missing = await api(`/api/v1/tenants/${new mongoose.Types.ObjectId().toHexString()}/data-exports`, { method: 'POST', headers: exporter.auth, body: { reason: 'nope nope' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'TENANT_NOT_FOUND');
});

test('a failed build releases the slot, records a sanitised error and leaves no artefact', async () => {
  const a = await onboard('Alpha');
  const row = await tenantExportRepository.create({
    exportId: 'tex_01jabcdefghjkmnpqrstvwxyz3',
    tenantId: a.tenantId,
    origin: 'platform',
    requestedBy: { type: 'admin', id: 'adm' },
    leaseUntil: new Date(Date.now() + 60000),
  });
  // Delete the tenant record behind the export's back.
  await Tenant.deleteOne({ _id: a.tenantId });
  const result = await tenantExportService.processExport({ exportId: row.exportId });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'TENANT_NOT_FOUND');
  const stored = await storageService.list(`tenant-exports/${a.tenantId}/`);
  assert.deepEqual(stored, []);
  const after = await TenantExport.findOne({ exportId: row.exportId }).lean();
  assert.equal(after.inFlight, undefined);
});

test('an owner can delete an archive before it expires; others cannot', async () => {
  const a = await onboard('Alpha');
  const b = await onboard('Beta');
  const done = await requestAndWait(a.auth);
  const exportPath = `/api/v1/workspace/data-exports/${done.exportId}`;
  const live = tenantExportService.signDownloadToken({ exportId: done.exportId, tenantId: a.tenantId, expiresAt: new Date(Date.now() + 60000), actor: { type: 'user', id: a.ownerId } });
  const row = await TenantExport.findOne({ exportId: done.exportId }).lean();

  assert.equal((await api(exportPath, { method: 'DELETE', headers: await member(a.tenantId, 'Viewer') })).status, 403);
  assert.equal((await api(exportPath, { method: 'DELETE', headers: b.auth })).status, 404);
  assert.equal((await api(exportPath, { method: 'DELETE' })).status, 401);
  assert.equal(await storageService.exists(row.storageKey), true);

  const deleted = await api(exportPath, { method: 'DELETE', headers: a.auth });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  assert.equal(deleted.json.data.status, 'expired');
  assert.equal(await storageService.exists(row.storageKey), false, 'the archive is gone');
  const link = await api(`${exportPath}/download-url`, { method: 'POST', headers: a.auth });
  assert.equal(link.status, 410);
  const again = await api(exportPath, { method: 'DELETE', headers: a.auth });
  assert.equal(again.status, 200, 'idempotent');
  assert.ok(await AuditLog.findOne({ tenantId: a.tenantId, action: 'tenant_export.deleted', actorType: 'user' }));
  // A link issued before the deletion stops working too.
  const tokenCheck = await tenantExportService.openDownload({ token: live }).then(() => 'opened', (err) => err.code);
  assert.equal(tokenCheck, 'EXPORT_EXPIRED');
});
