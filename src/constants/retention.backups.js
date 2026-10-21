/**
 * Retention declarations of the backups package (roadmap 2.9).
 *
 * Integration wires these into the cleanup job. TenantExport rows are
 * bookkeeping only (counts, checksums, who asked and when); the archives
 * themselves are deleted by the tenant-export-expiry job at `expiresAt`.
 * Rows are kept for a year as evidence of past data exports.
 */

export const RETENTION = Object.freeze([
  { model: 'TenantExport', field: 'createdAt', envKey: 'RETENTION_TENANT_EXPORT_DAYS', defaultDays: 365 },
]);

export default RETENTION;
