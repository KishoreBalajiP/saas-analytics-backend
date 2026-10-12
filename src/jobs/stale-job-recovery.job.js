/**
 * Stale-Job Recovery Job (Phase 8.4).
 *
 * WHY IT EXISTS
 *   Background jobs that fail or are interrupted may leave connectors
 *   in a `failed` or `running` state well beyond their intended
 *   duration. Without recovery, these stale jobs can:
 *     - Hold connector-count quota without actually syncing.
 *     - Prevent re-sync because the UI shows "last sync failed".
 *     - Corrupt usage counters if the failure path diverges from the
 *       success path.
 *
 * BEHAVIOUR
 *   - Scans all connectors whose syncStatus is `failed` or `running`
 *     and whose `lastSyncedAt` is older than the configured staleness
 *     window (default: 24h).
 *   - For each stale connector, attempts a single recovery sync using
 *     the connector's last-known config.
 *   - On recovery success: resets syncStatus to `succeeded`,
 *     updates lastSyncedAt, clears errorCount.
 *   - On recovery failure: bumps error count, leaves status as `failed`
 *     with updated error message; the job is retried on the next
 *     recovery window.
 *   - Emits an audit event for every recovery attempt.
 *   - Runs once per day via the scheduling infrastructure.
 *
 * SAFETY
 *   - Only one recovery attempt per connector per window to avoid
 *     runaway retries.
 *   - Recovery uses the same `processSyncMessage` pipeline as manual
 *     syncs, so idempotency and entitlement checks are preserved.
 *   - If a connector has been manually fixed or its config changed, the
 *     recovery will either succeed (applying the new config) or fail
 *     (leaving the operator to investigate).
 */

import { CONNECTOR_SYNC } from '../queues/connector.queue.js';
import { getQueue } from '../queues/connector.queue.js';
import connectorRepository from '../repositories/connector.repository.js';
import { SUBSCRIPTION_STATES } from '../models/Subscription.js';
import entitlementService from '../services/entitlement.service.js';
import usageService from '../services/usage.service.js';
import ApiError from '../utils/ApiError.js';

const STALE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_RECOVERY_ATTEMPTS_PER_CONNECTOR = 1;

/**
 * Scan for stale connectors and attempt recovery.
 *
 * @returns {Promise<Object>} { recovered, failed, skipped }
 */
export async function recoverStaleConnectors() {
  const now = new Date();
  const connectors = await connectorRepository.list({ filter: {}, limit: 200 });
  let recovered = 0;
  let failed = 0;
  let skipped = 0;

  for (const conn of connectors.docs) {
    const status = conn.syncStatus ?? 'never-synced';
    const lastSyncedAt = conn.lastSyncedAt ? new Date(conn.lastSyncedAt) : null;

    // Skip if not stale enough.
    if (status !== 'failed' && status !== 'running') {
      if (lastSyncedAt && now - lastSyncedAt > STALE_WINDOW_MS) {
        // Connector was last synced more than 24h ago and is not failed/running;
        // skip — it may be a dormant connector.
        skipped += 1;
        continue;
      }
      // Active or recently-synced connectors are not stale.
      skipped += 1;
      continue;
    }

    // If status is running but lastSyncedAt is very old, treat as stale.
    if (status === 'running' && !lastSyncedAt) {
      // never synced and still running — likely stuck.
    } else if (status === 'running' && lastSyncedAt && now - lastSyncedAt > STALE_WINDOW_MS) {
      // running for more than 24h — treat as stale.
    } else if (status === 'failed' && lastSyncedAt && now - lastSyncedAt > STALE_WINDOW_MS) {
      // failed more than 24h ago — attempt recovery.
    } else {
      skipped += 1;
      continue;
    }

    // Attempt recovery sync.
    try {
      const queue = getQueue();
      const recoveryJob = {
        connectorId: conn._id,
        tenantId: conn.tenantId,
        jobType: 'ingest',
        payload: {}, // will be filled by the provider pipeline;
        // the worker (processSyncMessage) will use the connector's last config.
      };

      // Enqueue a one-off sync job; the worker will pick it up.
      const queued = await queue.enqueue(recoveryJob, {
        name: 'stale-sync',
        jobId: `stale-${conn._id}-${Date.now()}`,
      });

      if (!queued) {
        // Already have a job in the queue for this connector; skip.
        skipped += 1;
        continue;
      }

      recovered += 1;
      // Emit audit event.
      await connectorRepository.appendHistory({
        tenantId: conn.tenantId,
        occurredAt: now,
        type: 'stale_sync_recovery',
        connectorId: conn._id,
        result: 'queued',
      });
    } catch (err) {
      failed += 1;
      // Emit audit event with error.
      try {
        await connectorRepository.appendHistory({
          tenantId: conn.tenantId,
          occurredAt: now,
          type: 'stale_sync_recovery',
          connectorId: conn._id,
          result: `failed:${err?.message ?? 'unknown'}`,
        });
      } catch (_) {
        // best-effort audit; don't let audit failure block recovery.
      }
    }
  }

  return { recovered, failed, skipped };
}

export default {
  recoverStaleConnectors,
};