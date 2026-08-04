/**
 * Tests for Mongoose plugins (tenantScope, softDelete, paginate, optimisticConcurrency, audit).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo } from '../helpers/index.js';
import { resetMongo } from '../helpers/mongo.js';
import { tenantScope } from '../../src/models/plugins/tenantScope.js';
import { softDelete } from '../../src/models/plugins/softDelete.js';
import { optimisticConcurrency } from '../../src/models/plugins/optimisticConcurrency.js';
import { paginate } from '../../src/models/plugins/paginate.js';
import { audit } from '../../src/models/plugins/audit.js';

useMongo();

const TENANT_A = 't_aaa';
const TENANT_B = 't_bbb';

function buildModel() {
  const schema = new mongoose.Schema(
    {
      tenantId: { type: String, index: true },
      name: { type: String },
    },
    { timestamps: true },
  );
  schema.plugin(tenantScope);
  schema.plugin(softDelete);
  schema.plugin(paginate);
  schema.plugin(optimisticConcurrency);
  schema.plugin(audit, { module: 'test' });
  // Avoid model re-registration across hot reloads.
  if (mongoose.models.TestDoc) return mongoose.models.TestDoc;
  return mongoose.model('TestDoc', schema);
}

test('tenantScope auto-filters reads', async () => {
  await resetMongo();
  const Model = buildModel();
  await Model.create({ tenantId: TENANT_A, name: 'A1' });
  await Model.create({ tenantId: TENANT_A, name: 'A2' });
  await Model.create({ tenantId: TENANT_B, name: 'B1' });
  Model.useScope({ tenantId: TENANT_A });
  const docs = await Model.find({});
  assert.equal(docs.length, 2);
  docs.forEach((d) => assert.equal(d.tenantId, TENANT_A));
  Model.clearScope();
});

test('tenantScope with bypassScope * reads across tenants', async () => {
  await resetMongo();
  const Model = buildModel();
  await Model.create({ tenantId: TENANT_A, name: 'A1' });
  await Model.create({ tenantId: TENANT_B, name: 'B1' });
  Model.useScope({ tenantScope: '*' });
  const docs = await Model.find({});
  assert.equal(docs.length, 2);
  Model.clearScope();
});

test('tenantScope refuses to save documents without tenantId', async () => {
  await resetMongo();
  const Model = buildModel();
  await assert.rejects(() => Model.create({ name: 'no-tenant' }), /tenantScope: "tenantId" is required/);
});

test('softDelete hides deleted documents and restores them', async () => {
  await resetMongo();
  const Model = buildModel();
  const doc = await Model.create({ tenantId: TENANT_A, name: 'doomed' });
  await doc.softDelete('usr_test');
  const visible = await Model.find({});
  assert.equal(visible.length, 0);
  const withDeleted = await Model.withDeleted().find({});
  assert.equal(withDeleted.length, 1);
  assert.ok(withDeleted[0].isDeleted());
  await withDeleted[0].restore();
  const after = await Model.find({});
  assert.equal(after.length, 1);
});

test('softDelete onlyDeleted returns only soft-deleted records', async () => {
  await resetMongo();
  const Model = buildModel();
  await Model.create({ tenantId: TENANT_A, name: 'alive' });
  const dead = await Model.create({ tenantId: TENANT_A, name: 'dead' });
  await dead.softDelete('usr_test');
  const onlyDead = await Model.onlyDeleted();
  assert.equal(onlyDead.length, 1);
  assert.equal(onlyDead[0].name, 'dead');
});

test('paginate returns the standard envelope', async () => {
  await resetMongo();
  const Model = buildModel();
  for (let i = 0; i < 25; i += 1) {
    await Model.create({ tenantId: TENANT_A, name: `doc-${i}` });
  }
  const result = await Model.paginate({ tenantId: TENANT_A }, { page: 1, limit: 10 });
  assert.equal(result.docs.length, 10);
  assert.equal(result.totalDocs, 25);
  assert.equal(result.limit, 10);
  assert.equal(result.page, 1);
  assert.ok(result.totalPages >= 3);
});

test('optimisticConcurrency increments __v on save', async () => {
  await resetMongo();
  const Model = buildModel();
  const doc = await Model.create({ tenantId: TENANT_A, name: 'v1' });
  const initialV = doc.__v ?? 0;
  doc.name = 'v2';
  await doc.save();
  assert.ok(doc.__v > initialV);
});

test('audit plugin emits create/update events', async () => {
  await resetMongo();
  const Model = buildModel();
  const events = [];
  Model.events.on('create', (e) => events.push({ type: 'create', name: e.doc.name }));
  Model.events.on('update', (e) => events.push({ type: 'update', name: e.doc.name }));
  const doc = await Model.create({ tenantId: TENANT_A, name: 'audited' });
  doc.name = 'audited-2';
  await doc.save();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'create');
  assert.equal(events[1].type, 'update');
});
