/** ai-insights: computations on hand-checked fixtures, guards, claim checker, causal lint, eval. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { periodChange, topMovers, outlier } from '../../src/services/insights/computations.js';
import { checkClaims, isCausal } from '../../src/services/insights/claimChecker.js';
import { narrate } from '../../src/services/insights/narrator.js';
import { runEval } from '../../scripts/ci/insights-eval.js';

test('period change: 1000 -> 880 is -120 / -12%; guard drops a 2% move', () => {
  const r = periodChange({ current: 880, previous: 1000 });
  assert.deepEqual(r.facts, { change: -120, changePct: -0.12 });
  assert.equal(periodChange({ current: 102, previous: 100 }), null);
});

test('top movers ranks by absolute change with contribution; needs 3 members', () => {
  const r = topMovers({ currentByMember: { EU: 150, US: 100, APAC: 60 }, previousByMember: { EU: 100, US: 110, APAC: 50 } });
  assert.deepEqual(r.facts.movers, [
    { member: 'EU', change: 50, contribution: 1 },
    { member: 'APAC', change: 10, contribution: 0.2 },
    { member: 'US', change: -10, contribution: -0.2 },
  ]);
  assert.equal(topMovers({ currentByMember: { a: 1, b: 2 }, previousByMember: {} }), null);
});

test('outlier vs median+MAD baseline; guard on short history', () => {
  const base = [10, 11, 9, 10, 12, 10, 11].map((value, i) => ({ period: `p${i}`, value }));
  const r = outlier({ series: [...base, { period: 'p7', value: 30 }] });
  assert.equal(r.facts.direction, 'above');
  assert.equal(r.cells.baseline.value, 10);
  assert.equal(outlier({ series: [...base, { period: 'p7', value: 11 }] }), null);
  assert.equal(outlier({ series: base.slice(0, 4) }), null);
});

test('claim checker keeps traceable numbers (cells, differences, ratios) and removes others', () => {
  const cells = { current: { value: 880 }, previous: { value: 1000 } };
  const { kept, removed } = checkClaims([
    { text: 'Revenue was 880 versus 1000.', cells: ['current', 'previous'] },
    { text: 'Revenue fell by 120 (12%).', cells: ['current', 'previous'] },
    { text: 'Revenue is 0.88 of last period.', cells: ['current', 'previous'] },
    { text: 'Revenue fell 15%.', cells: ['current', 'previous'] },
    { text: 'Revenue was 880.', cells: [] },
  ], cells);
  assert.equal(kept.length, 3);
  assert.deepEqual(removed.map((r) => r.reason), ['untraceable_number', 'no_cells']);
});

test('causal lint flags causal wording unless hedged and labelled', () => {
  assert.equal(isCausal({ text: 'Sales dropped due to the outage' }), true);
  assert.equal(isCausal({ text: 'The outage drove sales down' }), true);
  assert.equal(isCausal({ text: 'A possible contributor may be the outage, which led to fewer sales', label: 'possible_explanation' }), false);
  assert.equal(isCausal({ text: 'Sales fell 12% in September' }), false);
});

test('narration disabled path returns null (deterministic insight only)', async () => {
  assert.equal(await narrate({ type: 'period_change', cells: {}, facts: {} }), null);
});

test('narration with a fake provider is claim-checked', async () => {
  const provider = { isImplemented: true, narrate: async () => ({ ok: true, output: { claims: [
    { text: 'Revenue fell by 120.', cells: ['current', 'previous'] },
    { text: 'Revenue fell by 999.', cells: ['current', 'previous'] },
  ], caveats: ['partial month'] } }) };
  const r = await narrate({ type: 'period_change', cells: { current: { value: 880 }, previous: { value: 1000 } }, facts: {} }, { provider });
  assert.equal(r.claims.length, 1);
  assert.equal(r.removedCount, 1);
});

test('offline eval measures the unsupported-claim rate', () => {
  const fx = JSON.parse(readFileSync(new URL('../../scripts/ci/insights-eval/fixtures.json', import.meta.url), 'utf8'));
  const r = runEval(fx);
  assert.equal(r.checkerAccuracy, 1);
  assert.equal(r.unsupportedClaimRate, 0.4);
});
