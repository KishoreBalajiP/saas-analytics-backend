import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import { MasterData } from '../../src/models/MasterData.js';
import * as masterDataService from '../../src/services/masterData.service.js';

useMongo();
const { ObjectId } = mongoose.Types;
const CAT = 'countries';

before(async () => { await MasterData.init(); });

beforeEach(async () => { await resetMongo(); });

test('create then list then get', async () => {
  await masterDataService.create(CAT, { code: 'us', name: 'United States', locale: 'en', data: { iso2: 'US' } }, 'admin');
  const list = await masterDataService.list(CAT, { page: 1, limit: 20, locale: 'en' });
  assert.equal(list.total, 1);
  assert.equal(list.docs[0].name, 'United States');

  const got = await masterDataService.getById(CAT, list.docs[0]._id);
  assert.equal(got.code, 'us');
  assert.deepEqual(got.data, { iso2: 'US' });
});

test('duplicate code per locale is 409; different locale is allowed', async () => {
  await masterDataService.create(CAT, { code: 'us', name: 'United States', locale: 'en' }, 'admin');
  await assert.rejects(
    () => masterDataService.create(CAT, { code: 'us', name: 'USA', locale: 'en' }, 'admin'),
    (e) => e.statusCode === 409,
  );
  const other = await masterDataService.create(CAT, { code: 'us', name: 'United States', locale: 'fr' }, 'admin');
  assert.equal(other.locale, 'fr');
});

test('getById 404s on unknown', async () => {
  await assert.rejects(
    () => masterDataService.getById(CAT, new ObjectId().toString()),
    (e) => e.statusCode === 404,
  );
});

test('invalid catalogue throws 400', async () => {
  await assert.rejects(() => masterDataService.list('bad-catal!ogue'), (e) => e.statusCode === 400);
});

test('list supports search', async () => {
  await masterDataService.create(CAT, { code: 'us', name: 'United States', locale: 'en' }, 'admin');
  await masterDataService.create(CAT, { code: 'ca', name: 'Canada', locale: 'en' }, 'admin');
  const res = await masterDataService.list(CAT, { page: 1, limit: 20, locale: 'en', search: 'can' });
  assert.equal(res.total, 1);
  assert.equal(res.docs[0].code, 'ca');
});

test('update changes attributes', async () => {
  const created = await masterDataService.create(CAT, { code: 'us', name: 'United States', locale: 'en' }, 'admin');
  const updated = await masterDataService.update(CAT, created._id, { name: 'USA' }, 'admin');
  assert.equal(updated.name, 'USA');
});

test('soft delete hides then surfaces via withDeleted', async () => {
  const created = await masterDataService.create(CAT, { code: 'us', name: 'United States', locale: 'en' }, 'admin');
  const before = await masterDataService.list(CAT, { page: 1, limit: 20, locale: 'en' });
  assert.equal(before.total, 1);

  await masterDataService.remove(CAT, created._id, 'admin');
  const after = await masterDataService.list(CAT, { page: 1, limit: 20, locale: 'en' });
  assert.equal(after.total, 0);

  const withDeleted = await MasterData.findOne({ catalogue: CAT }).setOptions({ includeDeleted: true }).lean();
  assert.ok(withDeleted, 'soft-deleted row should still exist in the collection');
  assert.ok(withDeleted.deletedAt, 'deletedAt should be set');
  assert.equal(withDeleted.deletedBy, 'admin');
});

test('remove refuses system-bound items (409)', async () => {
  const created = await masterDataService.create(CAT, { code: 'sys', name: 'System Locale', locale: 'en', isSystem: true }, 'admin');
  await assert.rejects(() => masterDataService.remove(CAT, created._id, 'admin'), (e) => e.statusCode === 409);
});
