/**
 * Retention declarations for collections added by the delivery package.
 * DeliveryDestination (config) and DeliveryUnsubscribe (opt-outs must
 * persist) are not time-limited.
 */

export const RETENTION = Object.freeze([
  { model: 'DeliveryRun', field: 'createdAt', envKey: 'RETENTION_DELIVERY_RUNS_DAYS', defaultDays: 180 },
]);

export default RETENTION;
