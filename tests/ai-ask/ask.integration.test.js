/**
 * ai-ask: Ask a question over HTTP with a FAKE Anthropic SDK (no network):
 * gating (flag, kill switch, consent, permission, noop 501, quota), plan
 * validation (unauthorised dataset/field rejected, repair then abstain),
 * clarify/unanswerable, refusal/max_tokens, logging without rows, tenant
 * isolation, and the offline eval baseline.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import * as featureFlagService from '../../src/services/featureFlag.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import entitlementOverrideService from '../../src/services/entitlementOverride.service.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { AiQuestion } from '../../src/models/AiQuestion.js';
import { setSdkFactory, _forceProvider } from '../../src/services/aiProvider.adapter.js';
import { onboardTenant, memberOf, captureLogs } from '../platform-config/helpers.js';
import { runEval } from '../../scripts/ci/ai-eval.js';
import { entitleTenant } from '../helpers/billing.js';
import * as datasetSchemaService from '../../src/services/datasetSchema.service.js';

let replies = [];
let calls = [];
const fakeSdk = () => ({
  messages: {
    create: async (params) => {
      calls.push(params);
      const next = replies.shift() ?? { kind: 'unanswerable', unanswerable: { reason: 'out_of_scope' } };
      if (next.stop) return { stop_reason: next.stop, content: [], usage: { input_tokens: 10, output_tokens: 0 } };
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(next) }], usage: { input_tokens: 100, output_tokens: 20 } };
    },
  },
});

before(async () => { await startMongo(); await startHttp(); setSdkFactory(fakeSdk); });
beforeEach(async () => {
  await resetMongo(); await rbacCache.clearAll(); await cacheService.flushAll();
  replies = []; calls = []; _forceProvider('anthropic');
});
after(async () => { _forceProvider(null); setSdkFactory(null); await stopHttp(); await stopMongo(); });

async function setup() {
  const t = await onboardTenant();
  await entitleTenant(t.tenantId);
  const c = await connectorRepository.create({ tenantId: t.tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u' });
  await ConnectorRow.insertMany([
    { tenantId: t.tenantId, connectorId: c._id, sourceRowId: '1', data: { region: 'EU', amount: 10, email: 'a@x.io' } },
    { tenantId: t.tenantId, connectorId: c._id, sourceRowId: '2', data: { region: 'US', amount: 5, email: 'b@x.io' } },
  ]);
  await datasetSchemaService.profileConnector({ tenantId: t.tenantId, connectorId: String(c._id) });
  await featureFlagService.ensureDefaults();
  await featureFlagService.updateFlag({ key: 'ai.assistant', patch: { rollout: { strategy: 'tenantId', tenantIds: [t.tenantId] } }, actor: { type: 'admin', id: 'a' } });
  await api('/api/v1/ai/consent', { method: 'PUT', headers: t.headers, body: { granted: true } });
  return { ...t, ds: String(c._id) };
}
const ask = (headers, question = 'Revenue by region') => api('/api/v1/ai/questions', { method: 'POST', headers, body: { question } });

test('answers a validated plan with provenance; logs no rows and sends no personal fields', async () => {
  const t = await setup();
  replies = [{ kind: 'plan', plan: { datasetId: t.ds, metrics: [{ op: 'sum', field: 'amount', alias: 'revenue' }], groupBy: [{ field: 'region' }], assumptions: ['revenue = sum(amount)'] } }];
  let res;
  const logs = await captureLogs(async () => { res = await ask(t.headers); });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.outcome, 'answered');
  assert.deepEqual(res.json.data.result.rows.map((r) => r.revenue).sort(), [10, 5].sort());
  assert.equal(res.json.data.provenance.datasetId, t.ds);
  assert.deepEqual(res.json.data.assumptions, ['revenue = sum(amount)']);
  assert.ok(!JSON.stringify(calls[0]).includes('email'), 'personal field not sent');
  assert.equal(calls[0].model, 'claude-opus-5-5');
  const rec = await AiQuestion.findById(res.json.data.id).lean();
  assert.ok(rec.promptHash && rec.usage.inputTokens === 100);
  assert.ok(!JSON.stringify(rec).includes('"EU"') && !logs.includes('"EU"'), 'no result rows stored or logged');
});

test('unauthorised dataset or field is rejected; one repair round then abstain', async () => {
  const otherTenant = await onboardTenant();
  const other = { ds: String((await connectorRepository.create({ tenantId: otherTenant.tenantId, type: 'csv', name: 'Secret', status: 'active', createdBy: 'u' }))._id) };
  const t = await setup();
  replies = [
    { kind: 'plan', plan: { datasetId: other.ds, metrics: [{ op: 'count' }] } },
    { kind: 'plan', plan: { datasetId: t.ds, metrics: [{ op: 'sum', field: 'email' }] } },
  ];
  const res = await ask(t.headers);
  assert.equal(res.json.data.outcome, 'unanswerable');
  assert.equal(res.json.data.reason, 'invalid_plan');
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content, /VALIDATOR_ERRORS/);

  replies = [
    { kind: 'plan', plan: { datasetId: t.ds, metrics: [{ op: 'sum', field: 'nope' }] } },
    { kind: 'plan', plan: { datasetId: t.ds, metrics: [{ op: 'count' }] } },
  ];
  const repaired = await ask(t.headers);
  assert.equal(repaired.json.data.outcome, 'answered');
  assert.equal(repaired.json.data.result.rows[0].count, 2);
});

test('clarify, unanswerable, refusal and max_tokens', async () => {
  const t = await setup();
  replies = [{ kind: 'clarify', clarify: { question: 'Which?', options: ['a', 'b'] } }];
  assert.equal((await ask(t.headers)).json.data.outcome, 'clarify');
  replies = [{ kind: 'unanswerable', unanswerable: { reason: 'missing_field', missing: ['age'] } }];
  assert.equal((await ask(t.headers)).json.data.reason, 'missing_field');
  for (const stop of ['refusal', 'max_tokens']) {
    replies = [{ stop }];
    const r = await ask(t.headers);
    assert.equal(r.json.data.outcome, 'unanswerable', stop);
  }
});

test('gating: flag, kill switch, consent, permission, noop 501, quota; tenant isolation of records', async () => {
  const t = await setup();
  const viewer = await memberOf(t.tenantId, 'Viewer');
  assert.equal((await api('/api/v1/ai/consent', { method: 'PUT', headers: viewer.headers, body: { granted: false } })).status, 403);
  const none = await memberOf(t.tenantId, null);
  assert.equal((await ask(none.headers)).status, 403);

  const fresh = await onboardTenant();
  await entitleTenant(fresh.tenantId);
  assert.equal((await ask(fresh.headers)).json.code, 'AI_NOT_ENABLED');
  await featureFlagService.updateFlag({ key: 'ai.assistant', patch: { rollout: { strategy: 'tenantId', tenantIds: [t.tenantId, fresh.tenantId] } }, actor: { type: 'admin', id: 'a' } });
  assert.equal((await ask(fresh.headers)).json.code, 'AI_CONSENT_REQUIRED');

  _forceProvider('noop');
  const noop = await ask(t.headers);
  assert.equal(noop.status, 501);
  assert.equal(noop.json.code, 'AI_NOT_CONFIGURED');
  _forceProvider('anthropic');

  await featureFlagService.updateFlag({ key: 'ai.kill_switch', patch: { enabled: true }, actor: { type: 'admin', id: 'a' } });
  assert.equal((await ask(t.headers)).json.code, 'AI_DISABLED');
  await featureFlagService.updateFlag({ key: 'ai.kill_switch', patch: { enabled: false }, actor: { type: 'admin', id: 'a' } });

  await entitlementOverrideService.create({ tenantId: t.tenantId, metric: 'aiQuestionsPerDay', kind: 'limit', value: { max: 1, hard: true }, reason: 'test', by: 'admin' });
  await cacheService.flushAll();
  replies = [{ kind: 'clarify', clarify: { question: 'q', options: [] } }];
  const first = await ask(t.headers);
  assert.equal(first.status, 200);
  const second = await ask(t.headers);
  assert.equal(second.status, 429);
  assert.equal(second.json.code, 'QUOTA_EXCEEDED');
  const rec = first.json.data.id;
  assert.equal((await api(`/api/v1/ai/questions/${rec}`, { headers: fresh.headers })).status, 404, 'other tenant cannot read');
  assert.equal((await api(`/api/v1/ai/questions/${rec}/feedback`, { method: 'POST', headers: t.headers, body: { rating: 'up' } })).status, 200);
});

test('offline eval reports a baseline with zero unauthorised passes', async () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../scripts/ci/ai-eval/fixtures.json', import.meta.url), 'utf8'));
  const report = await runEval(fixtures);
  assert.equal(report.unauthorisedPasses, 0);
  assert.ok(report.score > 0.5);
});
