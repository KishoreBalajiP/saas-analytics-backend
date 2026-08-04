/**
 * Canonical queue names.
 *
 * WHY IT EXISTS
 *   Queue names are referenced both by the facade (`queues/index.js`) and by
 *   each queue contract (`queues/*.queue.js`). Keeping them in a leaf module
 *   avoids a circular import between those files.
 *
 * HOW TO EXTEND
 *   Add a new queue here, then create `queues/<name>.queue.js` and re-export
 *   it from `index.js`.
 */

export const QUEUE_NAMES = Object.freeze({
  CONNECTOR_SYNC: 'connector.sync',
  EMAIL_DELIVERY: 'email.delivery',
  ANALYTICS_JOBS: 'analytics.jobs',
});

export default QUEUE_NAMES;
