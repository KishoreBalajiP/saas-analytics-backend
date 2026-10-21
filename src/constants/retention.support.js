/**
 * Retention declarations for the support access collections (roadmap 2.3).
 *
 * Contract (retention package): integration wires these into the cleanup
 * job. Grants and impersonation records are part of the tenant-visible
 * support history, so they are kept as long as a year by default. The
 * per-admin daily counters also carry a TTL index (`expiresAt`), so the
 * entry below is a backstop.
 */

export const RETENTION = [
  { model: 'SupportAccessGrant', field: 'createdAt', envKey: 'RETENTION_SUPPORT_ACCESS_DAYS', defaultDays: 365 },
  { model: 'SupportImpersonation', field: 'createdAt', envKey: 'RETENTION_SUPPORT_ACCESS_DAYS', defaultDays: 365 },
  { model: 'SupportImpersonationCounter', field: 'createdAt', envKey: 'RETENTION_SUPPORT_COUNTER_DAYS', defaultDays: 7 },
];

export default { RETENTION };
