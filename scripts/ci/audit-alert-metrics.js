#!/usr/bin/env node
/**
 * Alert metric audit (operator step, roadmap 1.5). READ-ONLY.
 *
 * WHY IT EXISTS
 *   Alerts used to fall back silently to `count` when their `metric` was not
 *   an output of their query. Since roadmap 1.5 such a rule is refused at
 *   save time and its evaluations fail with ALERT_METRIC_INVALID (recorded
 *   on `lastEvaluation`). Rules saved before the change may be affected;
 *   this script lists them, plus rules whose query cannot be resolved
 *   (deleted dataset or widget, query rejected by the strict contract), so
 *   their owners can fix them.
 *
 * USAGE
 *   node scripts/ci/audit-alert-metrics.js                      # every tenant
 *   node scripts/ci/audit-alert-metrics.js --tenant <id> [--tenant <id>]
 *
 * SAFETY
 *   - Uses MONGODB_URI from the environment (same loader as the app) and
 *     never builds indexes on connect.
 *   - Writes nothing. Exit code 0 when every rule is valid, 2 when findings
 *     were reported, 1 on error.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse repeated `--tenant <id>` flags. */
export function parseArgs(argv = []) {
  const tenantIds = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--tenant' && argv[i + 1]) {
      tenantIds.push(String(argv[i + 1]));
      i += 1;
    }
  }
  return { tenantIds };
}

/**
 * Audit against the current Mongoose connection. Exported so tests can run
 * it against the in-memory server without connecting anywhere else.
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.tenantIds]
 * @param {(line: string) => void} [opts.log=console.log]
 */
export async function run({ tenantIds = [], log = console.log } = {}) {
  const alertService = await import('../../src/services/alert.service.js');
  const summary = await alertService.auditMetrics({
    tenantIds: tenantIds.length ? tenantIds : null,
    onFinding: (f) => {
      const where = `${f.tenantId} alert ${f.alertId} "${f.name}"${f.enabled ? '' : ' (disabled)'}`;
      if (f.problem === 'invalid_metric') {
        log(`metric   ${where}: "${f.metric}" is not one of ${f.outputs.join(', ')}`);
      } else {
        log(`broken   ${where}: ${f.reason}`);
      }
    },
  });
  log(`\n${summary.checked} alert(s) checked, ${summary.invalidMetric} with an invalid metric, ${summary.unresolvable} unresolvable. Nothing was changed.`);
  return summary;
}

async function main() {
  const { tenantIds } = parseArgs(process.argv.slice(2));
  const { connectDatabase, disconnectDatabase } = await import('../../src/config/database.js');
  const connected = await connectDatabase({ autoIndex: false });
  if (!connected) {
    console.error('Could not connect to MongoDB (check MONGODB_URI).');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await run({ tenantIds });
    if (summary.invalidMetric + summary.unresolvable > 0) process.exitCode = 2;
  } finally {
    await disconnectDatabase();
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
