#!/usr/bin/env node
/**
 * Permission catalogue migration (deploy step).
 *
 * WHY IT EXISTS
 *   Default roles are seeded once, when the first admin is bootstrapped and
 *   when each tenant is initialised. Permission keys added later (for
 *   example the billing keys `iam.subscriptions.*`, `iam.entitlements.view`
 *   and `billing.*`) never reach existing deployments without this step.
 *
 * USAGE
 *   npm run db:permissions                # dry run: report what would be attached
 *   npm run db:permissions -- --apply     # apply (idempotent, additive only)
 *
 * ORDER
 *   Run `npm run db:indexes -- --apply` first so the RolePermission unique
 *   index exists; it is what makes repeated attachment a no-op.
 *
 * SAFETY
 *   Creates missing modules/permissions and attaches catalogue permissions
 *   to the default tenant roles and to the legacy `super` / `platform`
 *   bootstrap roles (additive). Creates the four built-in platform roles
 *   (super_admin, platform_admin, support_operator, auditor; see
 *   `src/constants/platformRoles.js`) and converges their grants to the
 *   definition, which may detach keys from those built-in roles only. Never
 *   touches custom roles. Moving existing admins onto the built-in roles is
 *   a separate, reviewed step: `npm run db:platform-roles`.
 */

import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import adminBootstrap from '../../src/services/adminBootstrap.service.js';
import tenantInitialization from '../../src/services/tenantInitialization.service.js';
import { Tenant } from '../../src/models/Tenant.js';

const apply = process.argv.includes('--apply');

async function main() {
  // Connecting must not build indexes as a side effect.
  const connected = await connectDatabase({ autoIndex: false });
  if (!connected) {
    console.error('Could not connect to MongoDB (check MONGODB_URI).');
    process.exitCode = 1;
    return;
  }
  const dryRun = !apply;
  const platform = await adminBootstrap.syncPlatformCatalogue({ dryRun });
  console.log(`platform roles ${platform.roles.join(', ') || '(none found)'}: ${platform.attached} permission grants ${dryRun ? 'candidate' : 'attached'}`);
  for (const role of platform.builtIn ?? []) {
    if (role.conflict) {
      console.log(`built-in platform role ${role.name}: SKIPPED (a custom role already uses this name; rename it and re-run)`);
      continue;
    }
    const verb = dryRun ? 'would' : 'did';
    console.log(`built-in platform role ${role.name}: ${role.created ? `${verb} create, ` : ''}${role.attached} grants ${dryRun ? 'to attach' : 'attached'}, ${role.detached} ${dryRun ? 'to detach' : 'detached'}`);
  }

  const tenants = await Tenant.find({ status: { $in: ['active', 'suspended', 'disabled'] } }).select('_id slug').lean();
  let total = 0;
  for (const tenant of tenants) {
    const { attached } = await tenantInitialization.syncDefaultRolePermissions({ tenantId: String(tenant._id), dryRun });
    total += attached;
    if (attached) console.log(`tenant ${tenant.slug}: ${attached} grants ${dryRun ? 'candidate' : 'attached'}`);
  }
  console.log(`\n${tenants.length} tenants checked, ${total} default-role grants ${dryRun ? 'candidate (dry run; candidates include grants that already exist)' : 'newly attached'}.`);
  if (dryRun) console.log('Re-run with --apply to write.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
