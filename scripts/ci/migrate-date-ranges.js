#!/usr/bin/env node
/**
 * Legacy analytics date-range migration (deploy step for roadmap 1.2).
 *
 * WHY IT EXISTS
 *   The analytics query contract now requires `dateRange.field`. Stored
 *   dashboards, widgets, reports and alerts that filtered on ingestion time
 *   implicitly are rewritten to say so (`field: 'ingestedAt'`), keeping
 *   their numbers unchanged. See `src/services/dateRangeMigration.service.js`.
 *
 *   It also clears the legacy default `schedule.timezone: 'UTC'` on
 *   reports and alerts so their schedules follow the workspace time zone
 *   (skip with --keep-utc-schedules).
 *
 * USAGE
 *   npm run db:date-ranges                # dry run: report what would change
 *   npm run db:date-ranges -- --apply     # write the changes
 *   npm run db:date-ranges -- --apply --keep-utc-schedules
 *
 * SAFETY
 *   Dry run by default. Only `*.dateRange` paths (and, for the schedule
 *   step, `schedule.timezone` plus the re-projected next run) are written. Definitions
 *   listed under `stillInvalid` break the contract for another reason
 *   (e.g. an unknown filter operator) and need their owner to fix them.
 */

import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { migrateLegacyDateRanges, migrateLegacyScheduleTimezones } from '../../src/services/dateRangeMigration.service.js';

const apply = process.argv.includes('--apply');
const keepUtcSchedules = process.argv.includes('--keep-utc-schedules');

async function main() {
  const connected = await connectDatabase({ autoIndex: false });
  if (!connected) {
    console.error('Could not connect to MongoDB (check MONGODB_URI).');
    process.exitCode = 1;
    return;
  }
  const report = await migrateLegacyDateRanges({ dryRun: !apply });
  if (!keepUtcSchedules) Object.assign(report, await migrateLegacyScheduleTimezones({ dryRun: !apply }));
  for (const [name, summary] of Object.entries(report)) {
    console.log(`${name}: ${summary.scanned} scanned, ${summary.changed} ${apply ? 'updated' : 'would change'}`);
    if (summary.stillInvalid.length) {
      console.log(`  still rejected by the query contract (owner must fix): ${summary.stillInvalid.join(', ')}`);
    }
  }
  if (!apply) console.log('\nDry run. Re-run with --apply to write.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
