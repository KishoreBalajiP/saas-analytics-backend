/**
 * Retention of the collections added or changed by the members package
 * (roadmap 2.10). Integration wires these into the cleanup job.
 *
 * - TenantInvitation: invitations are no longer removed by a TTL index at
 *   expiry; accepted, revoked and expired rows are kept as history for this
 *   long (pending rows expire within INVITATION_TTL_DAYS, far sooner).
 * - TenantDeletion: the evidence of a workspace deletion (who asked, when,
 *   and the zero-count verification report of the purge).
 */
export const RETENTION = [
  { model: 'TenantInvitation', field: 'updatedAt', envKey: 'RETENTION_TENANT_INVITATION_DAYS', defaultDays: 365 },
  { model: 'TenantDeletion', field: 'createdAt', envKey: 'RETENTION_TENANT_DELETION_DAYS', defaultDays: 1095 },
];

export default RETENTION;
