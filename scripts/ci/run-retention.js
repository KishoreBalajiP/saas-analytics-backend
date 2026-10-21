#!/usr/bin/env node
/**
 * Retention run (operator step, roadmap 2.7).
 *
 * WHY IT EXISTS
 *   Before the cleanup job is enabled in production, an operator runs the
 *   retention policies once as a dry run to see how many rows and stored
 *   files each policy would delete, then applies them (or enables the job).
 *
 * USAGE
 *   npm run db:retention                       # dry run: report only
 *   npm run db:retention -- --apply            # delete what is past retention
 *   npm run db:retention -- --only auditLogs --only accessLogs
 *
 * SAFETY
 *   - Uses MONGODB_URI from the environment (same loader as the app) and
 *     never builds indexes on connect.
 *   - Dry run by default: nothing is deleted without --apply.
 *   - Honours every RETENTION_* window, the legal holds
 *     (RETENTION_LEGAL_HOLD_TENANT_IDS and `legalHold: true` tenants) and
 *     the batch bounds; re-running is safe.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse `--apply` and repeated `--only <policyKey>` flags. */
export function parseArgs(argv = []) {
  const only = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only' && argv[i + 1]) {
      only.push(String(argv[i + 1]));
      i += 1;
    }
  }
  return { apply: argv.includes('--apply'), only };
}

/**
 * Run the retention policies against the current Mongoose connection.
 * Exported so tests can run it against the in-memory server.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.apply=false]
 * @param {string[]} [opts.only]
 * @param {Object} [opts.settings] - overrides of env.retention (tests).
 * @param {Date} [opts.now]
 * @param {(line: string) => void} [opts.log=console.log]
 */
export async function run({ apply = false, only = [], settings, now, log = console.log } = {}) {
  const { default: retentionService } = await import('../../src/services/retention.service.js');
  const report = await retentionService.runRetention({
    dryRun: !apply,
    only: only.length > 0 ? only : null,
    ...(settings ? { settings } : {}),
    ...(now ? { now } : {}),
  });
  for (const p of report.policies) {
    if (p.skipped) {
      log(`skip     ${p.key}: ${p.skipped}${p.reason ? ` (${p.reason})` : ''}`);
    } else if (p.error) {
      log(`error    ${p.key}: ${p.error.code} ${p.error.message}`);
    } else {
      const n = apply ? p.deleted : p.matched;
      const extra = [
        p.objectsDeleted ? `${p.objectsDeleted} file(s)` : null,
        p.failed ? `${p.failed} failed` : null,
        p.more ? 'more remain' : null,
        p.heldBack ? 'held back by legal hold' : null,
      ].filter(Boolean).join(', ');
      log(`${apply ? 'deleted' : 'would  '}  ${p.key}: ${n} (${p.days} day window)${extra ? ` - ${extra}` : ''}`);
    }
  }
  log(
    `\n${report.totals[apply ? 'deleted' : 'matched']} row(s) ${apply ? 'deleted' : 'past retention'}, `
      + `${report.totals.objectsDeleted} file(s) deleted, ${report.totals.failed} failed, `
      + `${report.totals.errors} policy error(s). Legal holds: ${report.legalHoldTenantIds.length} tenant(s).`,
  );
  if (!apply) log('Dry run only. Re-run with --apply to delete.');
  return report;
}

async function main() {
  const { apply, only } = parseArgs(process.argv.slice(2));
  const { connectDatabase, disconnectDatabase } = await import('../../src/config/database.js');
  const connected = await connectDatabase({ autoIndex: false });
  if (!connected) {
    console.error('Could not connect to MongoDB (check MONGODB_URI).');
    process.exitCode = 1;
    return;
  }
  try {
    const report = await run({ apply, only });
    if (report.totals.errors > 0 || report.totals.failed > 0) process.exitCode = 1;
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
