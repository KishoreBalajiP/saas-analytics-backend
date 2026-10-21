#!/usr/bin/env node
/**
 * Usage-counter reconciliation (operator step, roadmap 1.3).
 *
 * WHY IT EXISTS
 *   Quota counters drifted while update/sync/delete paths consumed quota
 *   (fixed in Phase 0) and invitations, file syncs and failed creates
 *   leaked it. This script recounts every tenant's real resources
 *   (connectors, dashboards, reports, scheduled reports, alerts, seats,
 *   stored rows) and corrects the `current` usage counters.
 *
 * USAGE
 *   npm run db:reconcile-usage                          # dry run: report drift
 *   npm run db:reconcile-usage -- --apply               # write corrections
 *   npm run db:reconcile-usage -- --tenant <id> [--tenant <id>]
 *
 * SAFETY
 *   - Uses MONGODB_URI from the environment (same loader as the app) and
 *     never builds indexes on connect.
 *   - Dry run by default: nothing is written without --apply.
 *   - Each correction is compare-and-set: a counter that changed while the
 *     script ran, or within USAGE_RECONCILE_SETTLE_MS, is skipped and
 *     reported, never overwritten. Re-running is safe.
 *   - Metered counters (API calls per day) are not touched.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse `--apply` and repeated `--tenant <id>` flags. */
export function parseArgs(argv = []) {
  const tenantIds = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--tenant' && argv[i + 1]) {
      tenantIds.push(String(argv[i + 1]));
      i += 1;
    }
  }
  return { apply: argv.includes('--apply'), tenantIds };
}

/**
 * Reconcile against the current Mongoose connection. Exported so tests can
 * run it against the in-memory server without connecting anywhere else.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.apply=false]
 * @param {string[]} [opts.tenantIds]
 * @param {number} [opts.settleMs] - defaults to USAGE_RECONCILE_SETTLE_MS.
 * @param {(line: string) => void} [opts.log=console.log]
 */
export async function run({ apply = false, tenantIds = [], settleMs, log = console.log } = {}) {
  const { default: usageService } = await import('../../src/services/usage.service.js');
  const summary = await usageService.reconcileAll({
    dryRun: !apply,
    by: 'reconcile-usage-script',
    ...(settleMs !== undefined ? { settleMs } : {}),
    tenantIds: tenantIds.length > 0 ? tenantIds : null,
    onTenant: (report) => {
      if (report.error) {
        log(`error    ${report.tenantId}: ${report.error}`);
        return;
      }
      const drifted = report.metrics.filter((m) => m.drift !== 0);
      if (drifted.length === 0) return;
      const parts = drifted.map((m) => `${m.metric} ${m.recorded}->${m.actual} (${m.action})`);
      log(`${apply ? 'apply' : 'drift'}    ${report.tenantId}: ${parts.join(', ')}`);
    },
  });
  log(
    `\n${summary.tenants} tenant(s) checked, ${summary.drifted} drifted counter(s), `
      + `${summary.corrected} corrected, ${summary.skipped} skipped, ${summary.failed} failed.`,
  );
  if (!apply) log('Dry run only. Re-run with --apply to write corrections.');
  return summary;
}

async function main() {
  const { apply, tenantIds } = parseArgs(process.argv.slice(2));
  const { connectDatabase, disconnectDatabase } = await import('../../src/config/database.js');
  const connected = await connectDatabase({ autoIndex: false });
  if (!connected) {
    console.error('Could not connect to MongoDB (check MONGODB_URI).');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await run({ apply, tenantIds });
    if (summary.failed > 0) process.exitCode = 1;
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
