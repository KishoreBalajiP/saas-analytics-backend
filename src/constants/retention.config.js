/**
 * Retention declarations for the config package (roadmap 2.4).
 *
 * The configuration history grows with every settings, feature-flag and
 * email-template change. Integration folds this list into the retention
 * cleanup job (see the retention coverage contract). Rollback is only
 * possible to versions still inside the window, so the default is long.
 */

export const RETENTION = [
  { model: 'ConfigRevision', field: 'createdAt', envKey: 'RETENTION_CONFIG_REVISIONS_DAYS', defaultDays: 730 },
];

export default RETENTION;
