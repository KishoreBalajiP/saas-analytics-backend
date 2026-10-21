/** Retention declarations for the ai-insights package. */
export const RETENTION = Object.freeze([
  { model: 'Insight', field: 'createdAt', envKey: 'RETENTION_INSIGHTS_DAYS', defaultDays: 180 },
]);
export default RETENTION;
