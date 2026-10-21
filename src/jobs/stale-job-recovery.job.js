/**
 * Stale-job reaper (roadmap 1.4; findings ops.09, con.02, con.04, ops2.10).
 *
 * WHY IT EXISTS
 *   A worker can die mid-sync (deploy, crash, OOM). With the in-memory queue
 *   the job is gone; with BullMQ it is redelivered only while Redis still
 *   holds it. Either way the connector used to stay `queued`/`running`
 *   forever and refuse every new sync. Every queued/running sync now holds
 *   a lease that its worker renews; this job finds syncs whose lease expired
 *   and recovers them, and closes job runs whose process stopped
 *   heartbeating.
 *
 * BEHAVIOUR (every JOB_STALE_RECOVERY_CRON tick, default every 5 minutes)
 *   For each connector stuck in `queued`/`running` past its lease:
 *     1. Reset it atomically (still stale at write time, so a worker that
 *        just renewed, or a second reaper, never collides).
 *     2. Mark its open SyncRun(s) `abandoned` (LEASE_EXPIRED).
 *     3. Re-queue it as a new `recovery` SyncRun when the data can be pulled
 *        again (MongoDB connectors), the tenant is active and the recovery
 *        budget (CONNECTOR_SYNC_MAX_RECOVERIES) is not spent. File uploads
 *        cannot be replayed (the file lived in the lost message), so those
 *        connectors end `failed` with a message asking for a new upload.
 *   Then every JobRun still `running` past its lease becomes `abandoned`.
 *
 *   Returns counts that the scheduler stores on this job's own JobRun.
 */

import env from '../config/env.js';
import logger from '../utils/logger.js';
import connectorRepository from '../repositories/connector.repository.js';
import syncRunRepository from '../repositories/syncRun.repository.js';
import jobRunRepository from '../repositories/jobRun.repository.js';
import { isTenantActive } from './tenantGuard.js';

/** Providers whose data can be pulled again without the original message. */
const REPLAYABLE_TYPES = new Set(['mongodb']);
const BATCH_LIMIT = 200;

const INTERRUPTED_MESSAGE = 'The sync was interrupted before it finished';

/** User-facing reason stored on the connector and the abandoned run. */
function interruptedReason({ active, replay, type }) {
  if (!active) return 'Sync stopped: the workspace is not active';
  if (replay) return `${INTERRUPTED_MESSAGE}; it was queued again`;
  if (REPLAYABLE_TYPES.has(type)) return `${INTERRUPTED_MESSAGE}; start a new sync`;
  // Webhook events lived only in the lost message; senders redeliver
  // events whose delivery was not acknowledged. When a durable queue still
  // redelivers the message, the worker replays it under a fresh run (and
  // settles its storedRows reservation), see processSyncMessage.
  if (type === 'webhook') return `${INTERRUPTED_MESSAGE}; events not stored will need to be sent again`;
  return `${INTERRUPTED_MESSAGE}; upload the file again`;
}

/**
 * Recover connectors whose sync lost its lease.
 *
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.leaseMs]
 * @param {number} [options.maxRecoveries]
 * @param {Function} [options.requeue] - (connector, { recoveredFrom, recoveryAttempt }) => Promise; injectable for tests.
 * @returns {Promise<{ scanned: number, recovered: number, requeued: number, failed: number, syncRunsAbandoned: number }>}
 */
export async function recoverStaleConnectors({
  now = new Date(),
  leaseMs = env.connectors.syncLeaseMs,
  maxRecoveries = env.connectors.syncMaxRecoveries,
  requeue,
} = {}) {
  const requeueFn = requeue ?? (async (connector, meta) => {
    // Lazy import: the service imports this module's siblings; keep the
    // module graph acyclic at load time.
    const { requeueRecoveredSync } = await import('../services/connector.service.js');
    return requeueRecoveredSync({ connector, ...meta });
  });

  const stale = await connectorRepository.findStaleSyncs({ now, leaseMs, limit: BATCH_LIMIT });
  const counts = { scanned: stale.length, recovered: 0, requeued: 0, failed: 0, syncRunsAbandoned: 0 };

  for (const candidate of stale) {
    const connectorId = String(candidate._id);
    const tenantId = candidate.tenantId;
    try {
      const openRuns = await syncRunRepository.findOpenForConnector({ tenantId, connectorId });
      const previous = openRuns[0] ?? null;
      const recoveryAttempt = (previous?.recoveryAttempt ?? 0) + 1;
      const active = await isTenantActive(tenantId);
      const replay = active && REPLAYABLE_TYPES.has(candidate.type) && recoveryAttempt <= maxRecoveries;

      const reason = interruptedReason({ active, replay, type: candidate.type });

      const reset = await connectorRepository.resetStaleSync(connectorId, {
        now,
        leaseMs,
        patch: { syncStatus: 'failed', lastError: reason, syncLeaseUntil: null, currentSyncRunId: null },
      });
      if (!reset) continue; // renewed or already recovered by another reaper
      counts.recovered += 1;

      for (const run of openRuns) {
        const closed = await syncRunRepository.finish(run._id, {
          status: 'abandoned',
          finishedAt: now,
          error: { code: 'LEASE_EXPIRED', message: reason },
          retentionDays: env.retention?.syncRunDays ?? 90,
        });
        if (closed) counts.syncRunsAbandoned += 1;
      }

      if (replay) {
        try {
          await requeueFn(reset, { recoveredFrom: previous ? String(previous._id) : null, recoveryAttempt });
          counts.requeued += 1;
        } catch (err) {
          counts.failed += 1;
          logger.warn({ err: { message: err?.message }, connectorId, tenantId }, 'stale sync re-queue failed');
        }
      } else {
        counts.failed += 1;
      }
      logger.info({ connectorId, tenantId, requeued: replay }, 'stale connector sync recovered');
    } catch (err) {
      counts.failed += 1;
      logger.error({ err: { message: err?.message }, connectorId, tenantId }, 'stale connector recovery failed');
    }
  }
  return counts;
}

/**
 * Close job runs whose process stopped renewing their lease.
 *
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @returns {Promise<number>} runs closed.
 */
export async function closeStaleJobRuns({ now = new Date() } = {}) {
  return jobRunRepository.closeStale({ now, retentionDays: env.retention?.jobRunDays ?? 30 });
}

/** One reaper pass: connectors first, then job runs. */
export async function reap({ now = new Date(), ...options } = {}) {
  const connectors = await recoverStaleConnectors({ now, ...options });
  const jobRunsClosed = await closeStaleJobRuns({ now });
  return { ...connectors, jobRunsClosed };
}

export default {
  name: 'stale-job-recovery',
  cronExpression: env.jobs.staleJobRecovery.cron,
  enabled: env.jobs.staleJobRecovery.enabled,
  handler: async () => reap(),
  recoverStaleConnectors,
  closeStaleJobRuns,
  reap,
};
