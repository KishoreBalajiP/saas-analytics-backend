/**
 * ai-ask: configuration diagnosis, provider error mapping and dataset
 * relevance.
 *
 *   - /ai/status names the real configuration problem (unset or unsupported
 *     provider, missing key, non-Gemini model id), never the key itself
 *   - provider failures map to typed codes (credentials, model, quota,
 *     network) without echoing the provider's message
 *   - the planner is offered the datasets most relevant to the question, not
 *     the first 20 by id; a truncated search is reported; the context stays
 *     valid JSON under its size cap; no ready dataset -> no model call
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import {
  setSdkFactory,
  _forceProvider,
  diagnoseAiConfig,
  classifyProviderError,
  AI_CONFIG_ACTIONS,
  AI_ERROR_CODES,
} from '../../src/services/aiProvider.adapter.js';
import { buildContext, tokenize, CONTEXT_LIMITS } from '../../src/services/ai/context.js';
import { onboardTenant } from '../platform-config/helpers.js';
import { entitleTenant } from '../helpers/billing.js';
import * as datasetSchemaService from '../../src/services/datasetSchema.service.js';

let calls = [];
let behaviour = null;
const fakeSdk = () => ({
  models: {
    generateContent: async (params) => {
      calls.push(params);
      if (behaviour) return behaviour();
      return { candidates: [{ finishReason: 'STOP' }], text: JSON.stringify({ kind: 'unanswerable', unanswerable: { reason: 'out_of_scope' } }) };
    },
  },
});

before(async () => { await startMongo(); await startHttp(); setSdkFactory(fakeSdk); });
beforeEach(async () => {
  await resetMongo(); await rbacCache.clearAll(); await cacheService.flushAll();
  calls = []; behaviour = null; _forceProvider('gemini');
});
after(async () => { _forceProvider(null); setSdkFactory(null); await stopHttp(); await stopMongo(); });

async function dataset(tenantId, name, fields) {
  const c = await connectorRepository.create({ tenantId, type: 'csv', name, status: 'active', createdBy: 'u', lastSyncedAt: new Date() });
  await ConnectorRow.insertMany([0, 1].map((i) => ({
    tenantId, connectorId: c._id, sourceRowId: `${name}-${i}`, data: Object.fromEntries(fields.map((f, j) => [f, j % 2 ? i + 1 : `v${i}`])),
  })));
  await datasetSchemaService.profileConnector({ tenantId, connectorId: String(c._id) });
  return String(c._id);
}

async function askReady() {
  const t = await onboardTenant();
  await entitleTenant(t.tenantId);
  await api('/api/v1/ai/consent', { method: 'PUT', headers: t.headers, body: { granted: true } });
  return t;
}

test('configuration diagnosis names the actual problem without echoing values', () => {
  const cases = [
    [{ provider: 'noop', apiKey: '', model: 'gemini-2.5-flash' }, AI_ERROR_CODES.NOT_CONFIGURED],
    [{ provider: 'anthropic', apiKey: 'k', model: 'gemini-2.5-flash' }, AI_ERROR_CODES.PROVIDER_UNSUPPORTED],
    [{ provider: 'gemini', apiKey: '', model: 'gemini-2.5-flash' }, AI_ERROR_CODES.API_KEY_MISSING],
    [{ provider: 'gemini', apiKey: 'k', model: 'ggemini-3.6-flash' }, AI_ERROR_CODES.MODEL_INVALID],
    [{ provider: 'gemini', apiKey: 'k', model: 'claude-opus-5-5' }, AI_ERROR_CODES.MODEL_INVALID],
    [{ provider: 'gemini', apiKey: 'k', model: 'gemini-3.6-flash' }, null],
    [{ provider: 'gemini', apiKey: 'k', model: 'models/gemini-2.5-flash' }, null],
  ];
  for (const [cfg, problem] of cases) {
    const d = diagnoseAiConfig(cfg);
    assert.equal(d.problem, problem, JSON.stringify(cfg));
    assert.equal(d.ready, problem === null);
    if (problem) {
      const action = AI_CONFIG_ACTIONS[problem];
      assert.ok(action, `an action for ${problem}`);
      assert.ok(!action.includes(cfg.model) || cfg.model.startsWith('gemini-2.5'), 'the configured model id is not echoed');
    }
  }
});

test('provider failures map to typed codes and never leak the provider message', () => {
  const err = (message, extra) => Object.assign(new Error(message), extra);
  const cases = [
    [err('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}', { status: 400 }), AI_ERROR_CODES.AUTH_FAILED, 502],
    [err('PERMISSION_DENIED', { status: 403 }), AI_ERROR_CODES.AUTH_FAILED, 502],
    [err('models/gemini-9 is not found for API version v1beta', { status: 404 }), AI_ERROR_CODES.MODEL_UNAVAILABLE, 502],
    [err('RESOURCE_EXHAUSTED: quota', { status: 429 }), AI_ERROR_CODES.RATE_LIMITED, 429],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), AI_ERROR_CODES.UNREACHABLE, 503],
    [err('request timed out', { name: 'TimeoutError' }), AI_ERROR_CODES.TIMEOUT, 504],
    [err('something else', { status: 500 }), AI_ERROR_CODES.PROVIDER_ERROR, 502],
  ];
  for (const [input, code, status] of cases) {
    const mapped = classifyProviderError(input);
    assert.equal(mapped.code, code, input.message);
    assert.equal(mapped.statusCode, status, input.message);
    assert.ok(!mapped.message.includes('API key not valid'), 'provider text is not passed through');
  }
});

test('/ai/status reports a ready provider; an Ask failure from the provider is typed over HTTP', async () => {
  const t = await askReady();
  await dataset(t.tenantId, 'Orders', ['region', 'amount']);
  const status = await api('/api/v1/ai/status', { headers: t.headers });
  assert.equal(status.status, 200);
  assert.equal(status.json.data.providerConfigured, true);
  assert.equal(status.json.data.available, true);

  behaviour = () => { throw Object.assign(new Error('API key not valid. Please pass a valid API key.'), { status: 400 }); };
  const res = await api('/api/v1/ai/questions', { method: 'POST', headers: t.headers, body: { question: 'orders by region' } });
  assert.equal(res.status, 502);
  assert.equal(res.json.code, 'AI_AUTH_FAILED');
  assert.ok(!JSON.stringify(res.json).includes('API key not valid'));

  behaviour = () => { throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }); };
  const limited = await api('/api/v1/ai/questions', { method: 'POST', headers: t.headers, body: { question: 'orders by region' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, 'AI_RATE_LIMITED');

  _forceProvider('noop');
  const off = await api('/api/v1/ai/status', { headers: t.headers });
  assert.equal(off.json.data.reason, 'AI_NOT_CONFIGURED');
  assert.match(off.json.data.action, /AI_PROVIDER=gemini/);
});

test('the most relevant dataset is offered even beyond the first 20, and truncation is reported', async () => {
  const t = await askReady();
  // 24 unrelated datasets created first (lower ids), the relevant one last.
  for (let i = 0; i < 24; i += 1) await dataset(t.tenantId, `Sheet ${i}`, [`col_${i}`, 'value']);
  const invoices = await dataset(t.tenantId, 'Invoices', ['customer', 'invoice_total', 'issued_at']);

  const ctx = await buildContext({ tenantId: t.tenantId, question: 'Total invoice amount by customer' });
  assert.equal(ctx.datasets[0].id, invoices, 'the matching dataset ranks first');
  assert.equal(ctx.datasets.length, CONTEXT_LIMITS.datasets);
  assert.deepEqual(ctx.scope, { available: 25, offered: 20, truncated: true });
  assert.doesNotThrow(() => JSON.parse(ctx.data), 'context is valid JSON');

  // Over HTTP the planner sees the relevant dataset and the answer says the search was narrowed.
  const res = await api('/api/v1/ai/questions', { method: 'POST', headers: t.headers, body: { question: 'Total invoice amount by customer' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(JSON.stringify(calls[0]).includes(invoices));
  assert.equal(res.json.data.outcome, 'unanswerable');
  assert.deepEqual(res.json.data.scope, { available: 25, offered: 20, truncated: true });
  assert.match(res.json.data.message, /20 most relevant of your 25 datasets/);
});

test('a wide workspace is shrunk to valid JSON under the cap', async () => {
  const t = await askReady();
  const wide = Array.from({ length: 60 }, (_, i) => `a_rather_long_descriptive_field_name_number_${i}`);
  for (let i = 0; i < 12; i += 1) await dataset(t.tenantId, `Wide dataset ${i}`, wide);
  const ctx = await buildContext({ tenantId: t.tenantId, question: 'anything' });
  assert.ok(ctx.data.length <= CONTEXT_LIMITS.chars, `${ctx.data.length} chars`);
  const parsed = JSON.parse(ctx.data);
  assert.equal(parsed.datasets.length, ctx.datasets.length);
  assert.equal(ctx.scope.offered, ctx.datasets.length);
});

test('no ready dataset: answered truthfully without calling the model', async () => {
  const t = await askReady();
  const res = await api('/api/v1/ai/questions', { method: 'POST', headers: t.headers, body: { question: 'How many orders this month?' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.outcome, 'unanswerable');
  assert.equal(res.json.data.reason, 'no_datasets');
  assert.equal(calls.length, 0);
});

test('tokenize drops question filler and splits identifiers', () => {
  assert.deepEqual(tokenize('How many Orders were created this month?'), ['order', 'created']);
  // "total" is filler in questions, so it is dropped from names too (symmetric).
  assert.deepEqual(tokenize('invoiceTotal by product_categories'), ['invoice', 'product', 'category']);
});
