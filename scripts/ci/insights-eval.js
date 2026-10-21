#!/usr/bin/env node
/**
 * Offline unsupported-claim measurement (ai-insights). Runs recorded
 * narrator claims from scripts/ci/insights-eval/fixtures.json through the
 * claim checker and reports the unsupported-claim rate and checker accuracy.
 * No network, no database.  USAGE  npm run insights:eval
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClaims } from '../../src/services/insights/claimChecker.js';

export function runEval(fixtures) {
  let claims = 0; let removed = 0; let correct = 0;
  for (const item of fixtures.items) {
    const r = checkClaims(item.claims, item.cells);
    claims += item.claims.length; removed += r.removed.length;
    if (r.kept.length === item.expectKept) correct += 1;
  }
  return { items: fixtures.items.length, claims, unsupportedClaimRate: claims ? removed / claims : 0, checkerAccuracy: correct / fixtures.items.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const report = runEval(JSON.parse(readFileSync(path.join(dir, 'insights-eval', 'fixtures.json'), 'utf8')));
  console.log(`insights-eval: unsupported-claim rate ${(report.unsupportedClaimRate * 100).toFixed(1)}% over ${report.claims} claims; checker accuracy ${(report.checkerAccuracy * 100).toFixed(1)}%`);
}
