/**
 * Delivery Retry Job (delivery, roadmap 3.4).
 *
 * Retries webhook / Slack / Teams deliveries whose backoff elapsed; each
 * run is claimed atomically so concurrent instances never send twice.
 */

import env from '../config/env.js';
import * as deliveryService from '../services/delivery/index.js';

export default {
  name: 'delivery-retry',
  cronExpression: '* * * * *',
  enabled: env.jobs.deliveryRetry.enabled,
  handler: async () => deliveryService.retryDue(),
};
