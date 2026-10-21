#!/usr/bin/env node
/**
 * Platform role migration (deploy step for roadmap 2.1) [approval required].
 *
 * WHY IT EXISTS
 *   Before 2.1 every platform admin held one all-permissions bootstrap role
 *   (`super`, `platform` or `support`), so a support operator was as
 *   powerful as a super admin. This step moves each admin onto the built-in
 *   role for its `adminType` (super_admin, platform_admin, support_operator,
 *   auditor) and revokes the legacy grants. See
 *   `src/services/platformRoleMigration.service.js`.
 *
 * USAGE
 *   npm run db:platform-roles                    # dry run: before/after report
 *   npm run db:platform-roles -- --json          # dry run, full JSON report
 *   npm run db:platform-roles -- --apply         # write (after review/approval)
 *
 * ORDER
 *   1. npm run db:indexes -- --apply
 *   2. npm run db:permissions -- --apply   (creates the built-in roles)
 *   3. npm run db:platform-roles           (review the dry-run report)
 *   4. npm run db:platform-roles -- --apply
 *
 * SAFETY
 *   Dry run by default. Never grants a permission an admin does not already
 *   hold: such admins are reported as `needs_review` and left unchanged.
 *   Custom roles and tenant-scoped grants are never touched.
 */

import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { migratePlatformRoles } from '../../src/services/platformRoleMigration.service.js';

const apply = process.argv.includes('--apply');
const asJson = process.argv.includes('--json');

function preview(keys, max = 8) {
  if (keys.length === 0) return 'none';
  const head = keys.slice(0, max).join(', ');
  return keys.length > max ? `${head} (+${keys.length - max} more)` : head;
}

async function main() {
  const connected = await connectDatabase({ autoIndex: false });
  if (!connected) {
    console.error('Could not connect to MongoDB (check MONGODB_URI).');
    process.exitCode = 1;
    return;
  }
  const report = await migratePlatformRoles({ dryRun: !apply, by: 'migration:platform-roles' });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const warning of report.warnings) console.log(`WARNING: ${warning}`);
  for (const admin of report.admins) {
    const label = `${admin.email} [${admin.adminType}${admin.tenantScope ? `, scope ${admin.tenantScope}` : ''}, ${admin.status}]`;
    if (admin.action === 'needs_review') {
      console.log(`REVIEW   ${label}: ${admin.reason}; unchanged (would gain: ${preview(admin.gained)})`);
    } else if (admin.action === 'unchanged') {
      console.log(`OK       ${label}: already on ${admin.targetRole}`);
    } else {
      const verb = apply ? 'migrated' : 'would migrate';
      console.log(`${apply ? 'MIGRATED' : 'MIGRATE '} ${label}: ${verb} to ${admin.targetRole}; permissions ${admin.before.length} -> ${admin.after.length}; removed: ${preview(admin.removed)}`);
    }
  }
  const { summary } = report;
  console.log(`\n${summary.total} admins: ${summary.migrate} to migrate, ${summary.unchanged} unchanged, ${summary.needsReview} need review${apply ? `, ${summary.applied} applied` : ''}.`);
  if (!apply) console.log('Dry run. Review the report (use --json for every before/after set), then re-run with --apply.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
