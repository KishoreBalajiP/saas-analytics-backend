/**
 * Cleanup (retention) job (roadmap 2.7).
 *
 * WHY IT EXISTS
 *   Enforces the RETENTION_* windows: audit, access and login logs,
 *   sessions, used tokens, notifications, alert history, query records,
 *   job/sync runs, outbox emails, export and report artefacts, soft-deleted
 *   rows, deleted users and archived tenants (`services/retention.service.js`
 *   lists every policy).
 *
 * RESPONSIBILITY
 *   Run every policy once per tick in bounded batches and record the run
 *   report: per-collection counts on the JobRun (the scheduler stores the
 *   returned counts) and one `governance` audit event with the full report.
 *   A policy that fails does not stop the others; the run is then marked
 *   failed, with the counts still recorded.
 *
 * HOW TO EXTEND
 *   - Cron / enable flag: `JOB_CLEANUP_CRON` (default 03:00 daily) and
 *     `JOB_CLEANUP_ENABLED` (default false: run `npm run db:retention` as a
 *     dry run against production first, then enable).
 *   - `RETENTION_DRY_RUN=true` makes scheduled runs report without deleting.
 *   - New collections declare their window in
 *     `src/constants/retention.<package>.js`; the job picks them up.
 */

import logger from '../utils/logger.js';
import { JOB } from '../config/constants.js';
import env from '../config/env.js';
import retentionService from '../services/retention.service.js';
import { emit as emitAudit } from '../services/auditLog.service.js';

/** Compact per-policy summary for the audit event (no row data). */
function summarise(report) {
  const policies = {};
  for (const p of report.policies) {
    policies[p.key] = p.skipped
      ? { skipped: p.skipped }
      : p.error
        ? { error: p.error.code }
        : {
          matched: p.matched,
          deleted: p.deleted,
          ...(p.objectsDeleted ? { objectsDeleted: p.objectsDeleted } : {}),
          ...(p.failed ? { failed: p.failed } : {}),
          ...(p.more ? { more: true } : {}),
          ...(p.heldBack ? { heldBack: true } : {}),
        };
  }
  return {
    dryRun: report.dryRun,
    cutoffClock: report.now,
    legalHoldTenants: report.legalHoldTenantIds.length,
    totals: report.totals,
    policies,
  };
}

export default {
  name: JOB.NAMES.CLEANUP,
  cronExpression: env.jobs.cleanup.cron,
  enabled: env.jobs.cleanup.enabled,
  // A large first purge can take a while; the scheduler renews the lease.
  leaseMs: 30 * 60 * 1000,

  async handler({ dryRun = env.retention.dryRun, now, settings } = {}) {
    const report = await retentionService.runRetention({
      dryRun,
      ...(now ? { now } : {}),
      ...(settings ? { settings } : {}),
    });
    const counts = retentionService.toJobCounts(report);
    logger.info({ dryRun: report.dryRun, totals: report.totals }, 'Retention run finished');

    try {
      await emitAudit({
        actor: { type: 'system', id: 'cleanup-job', display: 'Retention job' },
        action: report.dryRun ? 'retention.dry_run' : 'retention.purge',
        module: 'governance',
        resource: { type: 'retention', id: null },
        after: summarise(report),
        result: report.totals.errors > 0 ? 'failure' : 'success',
      });
    } catch (err) {
      logger.warn({ err: { message: err?.message } }, 'Could not record the retention run in the audit trail');
    }

    if (report.totals.errors > 0) {
      const failed = report.policies.filter((p) => p.error).map((p) => p.key);
      const err = new Error(`Retention policies failed: ${failed.join(', ')}`);
      err.code = 'RETENTION_PARTIAL_FAILURE';
      err.counts = counts;
      throw err;
    }
    return counts;
  },
};
