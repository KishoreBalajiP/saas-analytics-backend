#!/usr/bin/env node
/**
 * Prepaid-term migration (operator step, billing roadmap 3.1).
 *
 * WHY IT EXISTS
 *   Before roadmap 3.1 a paid plan never expired and unpaid tenants were
 *   lazily put on `starter`. Access is now computed from the prepaid term,
 *   so existing rows need a deliberate move: never-paid active rows go to
 *   the free plan, and paid rows whose term already ended (or ends soon)
 *   get a notice term so renewal reminders go out before anything lapses.
 *   See `billingLifecycle.migrateLegacySubscriptions`.
 *
 * USAGE
 *   npm run db:billing-terms                          # dry run: report only
 *   npm run db:billing-terms -- --apply               # write the changes
 *   npm run db:billing-terms -- --apply --notice-days 45
 *
 * SAFETY
 *   - Dry run by default: nothing is written without --apply.
 *   - Uses MONGODB_URI from the environment (same loader as the app) and
 *     never builds indexes on connect.
 *   - Every write is compare-and-set with a history row; re-running is safe.
 *   - Run it in the same deploy window as roadmap 3.1, BEFORE enabling
 *     JOB_BILLING_LIFECYCLE_ENABLED, after reviewing the dry run.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseArgs(argv = []) {
  const i = argv.indexOf('--notice-days');
  const noticeDays = i !== -1 ? Number(argv[i + 1]) : 30;
  return {
    apply: argv.includes('--apply'),
    noticeDays: Number.isInteger(noticeDays) && noticeDays > 0 ? noticeDays : 30,
  };
}

/** Run against the current Mongoose connection (tests use the memory server). */
export async function run({ apply = false, noticeDays = 30, log = console.log } = {}) {
  const { default: billingLifecycle } = await import('../../src/services/billingLifecycle.service.js');
  const summary = await billingLifecycle.migrateLegacySubscriptions({ dryRun: !apply, noticeDays, log });
  log(
    `\n${summary.scanned} paid-plan subscription(s) scanned: ${summary.movedToFree} to free, `
      + `${summary.noticeExtended} notice term(s), ${summary.unchanged} unchanged, ${summary.errors} error(s).`,
  );
  if (!apply) log('Dry run only. Re-run with --apply to write the changes.');
  return summary;
}

async function main() {
  const { apply, noticeDays } = parseArgs(process.argv.slice(2));
  const { connectDatabase, disconnectDatabase } = await import('../../src/config/database.js');
  const connected = await connectDatabase({ autoIndex: false });
  if (!connected) {
    console.error('Could not connect to MongoDB (check MONGODB_URI).');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await run({ apply, noticeDays });
    if (summary.errors > 0) process.exitCode = 1;
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
