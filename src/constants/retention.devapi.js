/**
 * Retention declarations for collections added by the devapi package.
 */

export const RETENTION = Object.freeze([
  { model: 'ApiKeyUsage', field: 'createdAt', envKey: 'RETENTION_API_KEY_USAGE_DAYS', defaultDays: 400 },
]);

export default RETENTION;
