/**
 * Retention declarations for collections added by the adminauth package.
 * Integration wires them into the retention cleanup job (owner: retention).
 *
 * `AuthCooldown` is not listed: its documents carry a TTL index on
 * `expiresAt` and purge themselves.
 */

export const RETENTION = Object.freeze([
  { model: 'AdminInvitation', field: 'createdAt', envKey: 'RETENTION_ADMIN_INVITATIONS_DAYS', defaultDays: 365 },
]);

export default RETENTION;
