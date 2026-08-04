/**
 * Queue framework facade (placeholder).
 *
 * WHY IT EXISTS
 *   Connector synchronization, email delivery and analytics jobs must run
 *   asynchronously through queues so HTTP requests stay fast and work
 *   survives crashes. This facade defines the queue contract and names now;
 *   the concrete transport (in-memory for dev, Redis/BullMQ for production)
 *   is intentionally NOT implemented or installed in Phase 1.1.
 *
 * RESPONSIBILITY
 *   - Expose canonical queue names.
 *   - Provide `createQueue(name)` returning a fail-closed handle whose method
 *     surface (`enqueue`, `schedule`, `consume`, `on`, `close`) is the exact
 *     contract a future transport must satisfy.
 *   - Re-export the per-queue contracts in this folder.
 *
 * HOW TO EXTEND
 *   When queues are implemented, replace `createQueue`'s stub driver with the
 *   real adapter (in-memory Map for dev/tests, BullMQ on Redis for prod). Keep
 *   the same handle surface so callers never change.
 *
 *   ```js
 *   import { createQueue } from '../queues/index.js';
 *   const syncQueue = createQueue(QUEUE_NAMES.CONNECTOR_SYNC, { concurrency: 5 });
 *   await syncQueue.enqueue({ connectorId, tenantId, jobType: 'ingest', payload });
 *   ```
 */

import { createStubDriver } from '../utils/stubs.js';
import { QUEUE_NAMES } from './constants.js';
import connectorQueue from './connector.queue.js';
import emailQueue from './email.queue.js';
import analyticsQueue from './analytics.queue.js';

/** The documented handle surface every queue transport must implement. */
const QUEUE_METHODS = ['enqueue', 'schedule', 'consume', 'on', 'close'];

/**
 * Create a queue handle for the given name.
 * PLACEHOLDER: returns a fail-closed stub until a transport is implemented.
 *
 * @param {string} name - one of `QUEUE_NAMES`.
 * @param {Object} [options] - future: { concurrency, attempts, backoffMs }.
 * @returns {Object} queue handle (stub in Phase 1.1).
 */
export function createQueue(name, options = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('createQueue requires a queue name');
  }
  return Object.freeze({
    name,
    options,
    ...createStubDriver(`queue:${name}`, QUEUE_METHODS),
  });
}

export { connectorQueue, emailQueue, analyticsQueue };
export { QUEUE_NAMES };

export default {
  QUEUE_NAMES,
  createQueue,
  connectorQueue,
  emailQueue,
  analyticsQueue,
};
