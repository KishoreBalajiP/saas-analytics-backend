/**
 * Tenant data catalogue + archive format (roadmap 2.9).
 *
 * - Every Mongoose model in src/models is classified: exported (tenant data)
 *   or explicitly excluded with a reason. A new collection that is neither
 *   fails here, so it cannot silently drop out of (or leak into) exports.
 * - Archive helpers: canonical digests, id remapping, CSV cells, manifest
 *   validation of untrusted input.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

import catalogue, {
  EXPORTED,
  EXCLUDED,
  unclassifiedModels,
  redactDocument,
  exportedEntry,
} from '../../src/services/tenantDataCatalogue.js';
import {
  CollectionDigest,
  remapValue,
  remapDocument,
  invertIdMap,
  csvCell,
  csvLine,
  validateManifest,
  serializeDocument,
  parseDocument,
} from '../../src/services/tenantArchive.js';

const { ObjectId } = mongoose.Types;
const modelsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/models');

async function importAllModels() {
  for (const name of await fsp.readdir(modelsDir)) {
    if (name.endsWith('.js')) await import(pathToFileURL(path.join(modelsDir, name)).href);
  }
}

test('every registered model is either exported or explicitly excluded', async () => {
  await importAllModels();
  assert.deepEqual(unclassifiedModels(), [], 'classify new models in src/services/tenantDataCatalogue.js');
  const exported = new Set(EXPORTED.map((e) => e.model));
  for (const { model, reason } of EXCLUDED) {
    assert.ok(!exported.has(model), `${model} is not both exported and excluded`);
    assert.ok(reason.length > 10, `${model} has a reason`);
  }
  // Classified names refer to real models.
  for (const model of [...exported, ...EXCLUDED.map((e) => e.model)]) {
    assert.ok(mongoose.modelNames().includes(model), `${model} is a registered model`);
  }
});

test('credentials, tokens and platform records are excluded; tenant records are scoped', async () => {
  await importAllModels();
  const excluded = new Set(EXCLUDED.map((e) => e.model));
  for (const model of ['Session', 'EmailVerificationToken', 'PasswordResetToken', 'TenantInvitation', 'ApiKey', 'EmbedToken', 'LoginAttempt', 'Admin', 'AdminRole', 'JobRun', 'JobLock', 'TenantExport']) {
    assert.ok(excluded.has(model), `${model} is excluded`);
  }
  for (const entry of EXPORTED) {
    const schema = mongoose.model(entry.model).schema;
    if (entry.scope === 'tenant') assert.ok(schema.path('tenantId'), `${entry.model} has tenantId`);
    if (entry.scope === 'roles') assert.ok(schema.path('roleId'), `${entry.model} has roleId`);
    assert.ok(entry.remap === 'deep' || (Array.isArray(entry.remap) && entry.remap.length > 0), `${entry.model} remap policy`);
  }
  // Phase 1 collections and dataset rows are covered.
  for (const model of ['SyncRun', 'UsageCounter', 'UsageReservation', 'ConnectorRow', 'AuditLog', 'AccessLog']) {
    assert.ok(exportedEntry(model), `${model} is exported`);
  }
  // Any model with a tenantId path that is not exported is excluded on purpose.
  for (const name of mongoose.modelNames()) {
    if (mongoose.model(name).schema.path('tenantId') && !exportedEntry(name)) assert.ok(excluded.has(name), name);
  }
});

test('redactions remove secrets and never mutate the source document', () => {
  const user = { _id: new ObjectId(), tenantId: 't', passwordHash: 'h' };
  assert.equal(redactDocument(exportedEntry('User'), user).passwordHash, null);
  assert.equal(user.passwordHash, 'h');
  const connector = { _id: new ObjectId(), config: 'enc', webhookToken: 'whk' };
  const redacted = redactDocument(exportedEntry('Connector'), connector);
  assert.equal(redacted.config, null);
  assert.equal('webhookToken' in redacted, false, 'removed, so the sparse unique index never sees a null');
  const secret = redactDocument(exportedEntry('Setting'), { isSecret: true, value: 's' });
  const plain = redactDocument(exportedEntry('Setting'), { isSecret: false, value: 'p' });
  assert.equal(secret.value, null);
  assert.equal(plain.value, 'p');
});

test('collection digests are order-independent, content-sensitive and optionally id-blind', () => {
  const a = { _id: new ObjectId(), n: 1, at: new Date('2026-01-01T00:00:00Z'), nested: { b: 2, a: 1 } };
  const b = { _id: new ObjectId(), n: 2 };
  const d1 = new CollectionDigest();
  d1.add(a); d1.add(b);
  const d2 = new CollectionDigest();
  d2.add(b); d2.add({ nested: { a: 1, b: 2 }, at: new Date('2026-01-01T00:00:00Z'), n: 1, _id: a._id });
  assert.equal(d1.digest(), d2.digest(), 'order of documents and keys does not matter');
  const d3 = new CollectionDigest();
  d3.add(a); d3.add({ ...b, n: 3 });
  assert.notEqual(d1.digest(), d3.digest());
  const d4 = new CollectionDigest();
  d4.add(a); d4.add(a);
  const d5 = new CollectionDigest();
  d5.add(a);
  assert.notEqual(d4.digest(), d5.digest(), 'duplicates count');
  const idBlind1 = new CollectionDigest({ includeId: false });
  idBlind1.add(a);
  const idBlind2 = new CollectionDigest({ includeId: false });
  idBlind2.add({ ...a, _id: new ObjectId() });
  assert.equal(idBlind1.digest(), idBlind2.digest());
  // Serialisation round trip keeps BSON types.
  const back = parseDocument(serializeDocument(a));
  assert.equal(back._id.toHexString(), a._id.toHexString());
  assert.ok(back.at instanceof Date);
});

test('id remapping covers ObjectIds, tokens in strings and keys, and is reversible', () => {
  const oldA = new ObjectId();
  const oldB = new ObjectId();
  const map = new Map([[oldA.toHexString(), new ObjectId()], [oldB.toHexString(), new ObjectId()]]);
  const hash = 'ab'.repeat(32);
  const doc = {
    _id: oldA,
    ref: oldB,
    refString: oldB.toHexString(),
    path: `reports/${oldA.toHexString()}/x.csv`,
    list: [oldB, { deep: oldA.toHexString() }],
    keyed: { [oldB.toHexString()]: true },
    hash,
    other: new ObjectId(),
    when: new Date('2026-01-01T00:00:00Z'),
  };
  const out = remapValue(doc, map);
  assert.equal(out._id.toHexString(), map.get(oldA.toHexString()).toHexString());
  assert.equal(out.ref.toHexString(), map.get(oldB.toHexString()).toHexString());
  assert.equal(out.refString, map.get(oldB.toHexString()).toHexString());
  assert.equal(out.path, `reports/${map.get(oldA.toHexString()).toHexString()}/x.csv`);
  assert.equal(out.list[1].deep, map.get(oldA.toHexString()).toHexString());
  assert.deepEqual(Object.keys(out.keyed), [map.get(oldB.toHexString()).toHexString()]);
  assert.equal(out.hash, hash, 'longer hex strings are not ids');
  assert.equal(out.other.toHexString(), doc.other.toHexString(), 'unknown ids stay');
  assert.ok(out.when instanceof Date);
  assert.equal(doc.ref, oldB, 'the input is not mutated');

  const back = remapValue(out, invertIdMap(map));
  assert.equal(new CollectionDigest().digest(), new CollectionDigest().digest());
  const d1 = new CollectionDigest(); d1.add(doc);
  const d2 = new CollectionDigest(); d2.add(back);
  assert.equal(d1.digest(), d2.digest(), 'the inverse map restores the original');

  // Field-restricted policy never touches other fields (dataset values).
  const row = { tenantId: oldA.toHexString(), connectorId: oldB, data: { ref: oldB.toHexString() } };
  const remapped = remapDocument(row, ['tenantId', 'connectorId'], map);
  assert.equal(remapped.data.ref, oldB.toHexString());
  assert.equal(remapped.connectorId.toHexString(), map.get(oldB.toHexString()).toHexString());
});

test('CSV cells are quoted per RFC 4180 and formula injection is neutralised', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  for (const formula of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) assert.ok(csvCell(formula).replace(/^"/, '').startsWith("'"), formula);
  assert.equal(csvCell(-5), '-5', 'numbers are not escaped');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(true), 'true');
  assert.equal(csvCell(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z');
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  assert.equal(csvLine(['a', 1, null]), 'a,1,');
});

test('manifest validation rejects anything outside the catalogue layout', () => {
  const tenantId = new ObjectId().toHexString();
  const sha = 'a'.repeat(64);
  const entry = (model) => ({
    model,
    collection: catalogue.collectionNameOf(model),
    file: catalogue.collectionFileOf(model),
    count: 1,
    bytes: 10,
    sha256: sha,
    contentSha256: sha,
  });
  const valid = () => ({
    format: 'analivo.tenant-export',
    formatVersion: 1,
    exportId: 'tex_abc',
    tenant: { id: tenantId },
    collections: [entry('Tenant'), entry('Dashboard')],
    datasets: [{ connectorId: new ObjectId().toHexString(), file: 'datasets/x.csv', rows: 1, bytes: 1, sha256: sha }],
    references: [],
  });
  assert.ok(validateManifest(valid(), catalogue));

  const cases = [
    (m) => { m.format = 'other'; },
    (m) => { m.tenant.id = 'not-an-id'; },
    (m) => { m.collections.push({ ...entry('Dashboard'), model: 'Session', collection: 'sessions', file: 'collections/sessions.jsonl' }); },
    (m) => { m.collections[1].collection = 'users'; },
    (m) => { m.collections[1].file = '../../etc/passwd'; },
    (m) => { m.collections[1].sha256 = 'zz'; },
    (m) => { m.collections[1].count = -1; },
    (m) => { m.collections.push(entry('Dashboard')); },
    (m) => { m.collections = m.collections.filter((c) => c.model !== 'Tenant'); },
    (m) => { m.datasets[0].file = m.collections[1].file; },
    (m) => { m.datasets[0].connectorId = '../x'; },
  ];
  for (const [index, mutate] of cases.entries()) {
    const manifest = valid();
    mutate(manifest);
    assert.throws(() => validateManifest(manifest, catalogue), (err) => err.code === 'ARCHIVE_MANIFEST_INVALID', `case ${index}`);
  }
  const future = valid();
  future.formatVersion = 2;
  assert.throws(() => validateManifest(future, catalogue), (err) => err.code === 'ARCHIVE_VERSION_UNSUPPORTED');
});
