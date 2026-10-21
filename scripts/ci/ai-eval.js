#!/usr/bin/env node
/**
 * Offline AI planner evaluation (ai-ask, audit doc 08 section 11).
 *
 * Replays RECORDED planner outputs (no network, no provider) from
 * scripts/ci/ai-eval/fixtures.json through the deterministic validator and
 * scores: plan validity, dataset-selection accuracy, appropriate abstention
 * and unauthorised passes (any pass is a release blocker -> exit 1).
 *
 * USAGE  npm run ai:eval [-- --json]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runEval(fixtures) {
  const { validatePlan } = await import('../../src/services/ai/validator.js');
  const results = fixtures.items.map((item) => {
    const out = item.recorded;
    let got = out.kind;
    let datasetId = null;
    if (out.kind === 'plan') {
      const v = validatePlan(out.plan, fixtures.context);
      got = v.ok ? 'plan' : 'rejected';
      datasetId = v.ok ? v.datasetId : null;
    }
    const pass = got === item.expect.kind && (!item.expect.datasetId || item.expect.datasetId === datasetId);
    return { id: item.id, category: item.category, expected: item.expect.kind, got, pass };
  });
  const plans = results.filter((r) => r.expected === 'plan');
  const abstain = results.filter((r) => ['clarify', 'unanswerable'].includes(r.expected));
  const unauthorisedPasses = results.filter((r) => r.expected === 'rejected' && r.got === 'plan').length;
  return {
    total: results.length,
    score: results.filter((r) => r.pass).length / results.length,
    planValidity: plans.filter((r) => r.got === 'plan').length / (plans.length || 1),
    datasetSelection: plans.filter((r) => r.pass).length / (plans.length || 1),
    abstention: abstain.filter((r) => r.pass).length / (abstain.length || 1),
    unauthorisedPasses,
    results,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const fixtures = JSON.parse(readFileSync(path.join(dir, 'ai-eval', 'fixtures.json'), 'utf8'));
  const report = await runEval(fixtures);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`ai-eval: score ${(report.score * 100).toFixed(1)}% over ${report.total} items; plan validity ${(report.planValidity * 100).toFixed(1)}%, abstention ${(report.abstention * 100).toFixed(1)}%, unauthorised passes ${report.unauthorisedPasses}`);
  }
  process.exit(report.unauthorisedPasses > 0 ? 1 : 0);
}
