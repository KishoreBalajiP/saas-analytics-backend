/**
 * Retention declarations for the detection package (roadmap 2.6), wired into
 * the cleanup job at integration (see contracts: retention coverage).
 *
 * - SecurityAlert follows the AUDIT retention policy: a closed alert
 *   (resolved / false positive) is purged `RETENTION_AUDIT_LOG_DAYS` after
 *   it was closed. Open and acknowledged alerts have `closedAt: null` and are
 *   never purged until somebody triages them.
 * - SecuritySignal rows (per-minute request counters) also carry a TTL index
 *   on `expiresAt` set from `RETENTION_SECURITY_SIGNAL_DAYS`; the entry here
 *   keeps the cleanup job's coverage report complete.
 */

export const RETENTION = Object.freeze([
  Object.freeze({
    model: 'SecurityAlert',
    field: 'closedAt',
    envKey: 'RETENTION_AUDIT_LOG_DAYS',
    defaultDays: 90,
  }),
  Object.freeze({
    model: 'SecuritySignal',
    field: 'bucket',
    envKey: 'RETENTION_SECURITY_SIGNAL_DAYS',
    defaultDays: 35,
  }),
]);

export default RETENTION;
