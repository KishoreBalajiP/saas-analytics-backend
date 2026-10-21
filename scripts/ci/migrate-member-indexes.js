#!/usr/bin/env node
/**
 * Member index migration (deploy step, roadmap 2.10).
 *
 * WHY IT EXISTS
 *   Unique indexes on users, roles, grants, settings, feature flags and the
 *   permission catalogue are now partial on live rows (`deletedAt: null`) so
 *   soft-deleted rows no longer block re-creating the same email / name /
 *   key; the TTL index on `TenantInvitation.expiresAt` is gone so invitation
 *   history is kept. Existing databases still hold the old definitions under
 *   the same index names, which `npm run db:indexes` cannot replace (it
 *   never drops). This script rebuilds exactly those indexes.
 *
 * USAGE
 *   npm run db:member-indexes              # dry run: print the plan
 *   npm run db:member-indexes -- --apply   # drop + recreate the listed indexes
 *
 * ORDER
 *   Run in a quiet period (each rebuild briefly drops a unique constraint),
 *   then `npm run db:indexes -- --apply` to create anything still missing.
 */

import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { migrateMemberIndexes } from '../../src/services/memberIndexMigration.service.js';

const apply = process.argv.includes('--apply');

async function main() {
  const connected = await connectDatabase({ autoIndex: false });
  if (!connected) {
    console.error('Could not connect to MongoDB (check MONGODB_URI).');
    process.exitCode = 1;
    return;
  }
  const report = await migrateMemberIndexes({ dryRun: !apply });
  let failures = 0;
  for (const row of report) {
    const label = `${row.model} ${JSON.stringify(row.key)}`;
    const state = row.error ? `error: ${row.error}` : (row.applied ? 'applied' : (apply ? 'unchanged' : 'planned'));
    if (row.error) failures += 1;
    console.log(`${row.action.padEnd(8)} ${label}${row.index ? ` (existing ${row.index})` : ''} - ${row.action === 'ok' ? 'up to date' : state}`);
  }
  if (!apply) console.log('\nDry run only. Re-run with --apply to rebuild the indexes above.');
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
