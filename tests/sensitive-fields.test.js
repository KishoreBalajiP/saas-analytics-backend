import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSensitiveFieldName, stripSensitiveFields, sensitiveKeysIn } from '../src/utils/sensitiveFields.js';

test('denylist blocks credential-like names and keeps innocent analytics columns', () => {
  for (const k of ['password', 'passwordHash', 'password_hash', 'pwd', 'otp', 'otpCode', 'resetToken', 'reset_code',
    'refresh_token', 'accessToken', 'authToken', 'fcmToken', 'fcm_token', 'pushToken', 'api_key', 'apiKey', 'client_secret',
    'salt', 'sessionId', 'privateKey', 'credentials', 'jwt', 'user.pwd']) {
    assert.equal(isSensitiveFieldName(k), true, k);
  }
  for (const k of ['revenue', 'tokens_used', 'session_count', 'hashtag', 'compass', 'bypass_rate', 'region', 'email_count']) {
    assert.equal(isSensitiveFieldName(k), false, k);
  }
});

test('stripSensitiveFields removes nested sensitive keys without mutating input', () => {
  const input = { name: 'a', password: 'x', profile: { fcm_token: 't', city: 'c' }, list: [{ otp: 1, v: 2 }] };
  const out = stripSensitiveFields(input);
  assert.deepEqual(out, { name: 'a', profile: { city: 'c' }, list: [{ v: 2 }] });
  assert.equal(input.password, 'x');
  assert.deepEqual(sensitiveKeysIn(input).sort(), ['list.otp', 'password', 'profile.fcm_token']);
});

test('analytics engine rejects sensitive fields in filters, metrics, groupBy and orderBy', async () => {
  const engine = await import('../src/services/analytics.engine.js');
  const cases = [
    { filters: [{ field: 'passwordHash', op: 'eq', value: 'x' }] },
    { metrics: [{ op: 'count_distinct', field: 'fcm_token' }] },
    { groupBy: ['otp'] },
    { orderBy: [{ field: 'reset_token', direction: 'asc' }] },
  ];
  for (const q of cases) {
    assert.throws(() => engine.validateQuery(q), (err) => /protected field/.test(JSON.stringify(err)), JSON.stringify(q));
  }
  assert.doesNotThrow(() => engine.validateQuery({ groupBy: ['region'], metrics: [{ op: 'sum', field: 'tokens_used' }] }));
});

test('engine raw-query pagination is capped', async () => {
  const engine = await import('../src/services/analytics.engine.js');
  assert.throws(() => engine.validateQuery({ pagination: { limit: engine.LIMITS.maxLimit + 1 } }));
});

test('schema discovery never profiles sensitive columns', async () => {
  const { inferFields } = await import('../src/services/datasetSchema.service.js');
  const names = inferFields([{ region: 'eu', password: 'p', fcmToken: 't' }]).map((f) => f.name);
  assert.deepEqual(names, ['region']);
});

test('AI validator refuses plans on sensitive fields even if a schema lists them', async () => {
  const { validatePlan } = await import('../src/services/ai/validator.js');
  const datasets = [{ id: 'd1', fields: [{ name: 'region', type: 'string' }, { name: 'password', type: 'string' }] }];
  const res = validatePlan({ datasetId: 'd1', groupBy: [{ field: 'password' }], metrics: [{ op: 'count' }] }, { datasets, metrics: [] });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /password/.test(e)));
});
