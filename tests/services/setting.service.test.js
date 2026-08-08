/**
 * Sprint 3 — Setting service unit/integration tests.
 *
 * WHY IT EXISTS
 *   Pins down the small but easy-to-break pieces of the settings surface
 *   that the HTTP integration test only touches indirectly: value coercion
 *   (string/number/boolean/duration/json), secret redaction, the effective
 *   inheritance rule (tenant > platform > default), cache invalidation on
 *   write, and the read-only hard rejection on tenant overrides.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { Setting } from '../../src/models/Setting.js';
import * as cache from '../../src/services/cache.service.js';
import * as settingRepository from '../../src/repositories/setting.repository.js';
import * as settingService from '../../src/services/setting.service.js';

before(async () => {
  await startMongo();
  await Setting.init();
});

beforeEach(async () => {
  await resetMongo();
  await cache.flushAll();
});

after(async () => {
  await stopMongo();
});

/* ------------------------------ coercion ------------------------------ */

test('coerceValue shapes values to their declared type', () => {
  assert.equal(settingRepository.coerceValue('string', 123), '123');
  assert.equal(settingRepository.coerceValue('number', '42'), 42);
  assert.equal(settingRepository.coerceValue('boolean', 'true'), true);
  assert.equal(settingRepository.coerceValue('duration', '5000'), 5000);
  assert.deepEqual(settingRepository.coerceValue('json', '{"a":1}'), { a: 1 });
});

test('coerceValue rejects bad input', () => {
  assert.throws(() => settingRepository.coerceValue('number', 'nope'), /finite number/);
  assert.throws(() => settingRepository.coerceValue('duration', -5), /non-negative/);
  assert.throws(() => settingRepository.coerceValue('boolean', 'yes'), /boolean/);
  assert.throws(() => settingRepository.coerceValue('json', '{bad'), /valid JSON/);
});

test('unknown type throws', () => {
  assert.throws(() => settingRepository.coerceValue('weird', 1), /Unknown setting type/);
});

/* --------------------------- redaction ---------------------------- */

test('redactSetting hides secrets unless includeSecrets', () => {
  const secret = { key: 'email.smtp_password', isSecret: true, value: 'hunter2' };
  const publicView = settingService.redactSetting(secret, false);
  assert.equal(publicView.value, null);
  assert.equal(publicView.redacted, true);

  const secretView = settingService.redactSetting(secret, true);
  assert.equal(secretView.value, 'hunter2');
  assert.equal(secretView.redacted, undefined);
});

/* ---------------------- effective inheritance ---------------------- */

test('resolveEffective: platform wins when no tenant override exists', async () => {
  const by = await settingRepository.create({
    key: 'email.from_name', scope: 'platform', tenantId: null, type: 'string', value: 'Platform', group: 'email',
    description: '', isSecret: false, isReadonly: false, updatedBy: 'svc',
  });

  const tenantId = String(by.tenantId ?? 'tenant');
  const effective = await settingService.resolveEffective('email.from_name', { tenantId: 't_unknown' });
  assert.equal(effective, 'Platform');
});

test('resolveEffective: tenant override beats platform', async () => {
  await settingRepository.create({
    key: 'email.from_name', scope: 'platform', tenantId: null, type: 'string', value: 'Platform', group: 'email',
    description: '', isSecret: false, isReadonly: false,
  });
  const tenantId = 'tenant_abc';
  await settingRepository.create({
    key: 'email.from_name', scope: 'tenant', tenantId, type: 'string', value: 'TenantOverride', group: 'email',
    description: '', isSecret: false, isReadonly: false,
  });

  const effective = await settingService.resolveEffective('email.from_name', { tenantId });
  assert.equal(effective, 'TenantOverride');
});

test('resolveEffective returns null for an unknown key', async () => {
  const effective = await settingService.resolveEffective('does.not.exist', { tenantId: 'x' });
  assert.equal(effective, null);
});

/* ---------------------- cache invalidation ---------------------- */

test('a write invalidates the cached effective value', async () => {
  await settingRepository.create({
    key: 'email.from_name', scope: 'platform', tenantId: null, type: 'string', value: 'Platform', group: 'email',
    description: '', isSecret: false, isReadonly: false,
  });
  const tenantId = 'tenant_xyz';

  // Prime the cache.
  const first = await settingService.resolveEffective('email.from_name', { tenantId });
  assert.equal(first, 'Platform');

  // Override and read again - the cache must NOT serve the stale 'Platform'.
  await settingRepository.create({
    key: 'email.from_name', scope: 'tenant', tenantId, type: 'string', value: 'Changed', group: 'email',
    description: '', isSecret: false, isReadonly: false,
  });
  const second = await settingService.resolveEffective('email.from_name', { tenantId });
  assert.equal(second, 'Changed');
});

/* ---------------------- read-only protection ---------------------- */

test('update rejects value changes on a read-only setting', async () => {
  const id = await settingRepository.create({
    key: 'security.lockout_threshold', scope: 'platform', tenantId: null, type: 'number', value: 5, group: 'security',
    description: '', isSecret: false, isReadonly: true,
  });

  await assert.rejects(
    () => settingService.update(id._id, { value: 99 }, { by: 'root' }),
    (err) => err.statusCode === 403 && /read-only/i.test(err.message),
  );
});

test('update allows non-value patches on a read-only setting', async () => {
  const doc = await settingRepository.create({
    key: 'security.lockout_threshold', scope: 'platform', tenantId: null, type: 'number', value: 5, group: 'security',
    description: '', isSecret: false, isReadonly: true,
  });

  const updated = await settingService.update(doc._id, { description: 'tweaked' }, { by: 'root' });
  assert.equal(updated.description, 'tweaked');
});
