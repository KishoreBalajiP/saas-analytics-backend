/**
 * Email delivery queue contract.
 *
 * WHY IT EXISTS
 *   Transactional email and alert notifications should be queued and sent
 *   by a worker (`jobs/email.job.js` polls the queue), decoupling the HTTP
 *   request from the SMTP round-trip.
 *
 * RESPONSIBILITY
 *   - Define the queue name and message shape.
 *   - Provide the consumer registration point (fail-closed stub for now).
 *
 * MESSAGE SHAPE (documented, not enforced):
 *   {
 *     emailId,    // persisted email record id
 *     to,         // recipient address
 *     template,   // template name from src/templates/emails/
 *     data,       // template variables (render on send)
 *     retryCount, // incremented by the worker on failure
 *   }
 */

import { QUEUE_NAMES } from './constants.js';
import { createQueue } from './index.js';

const QUEUE_NAME = QUEUE_NAMES.EMAIL_DELIVERY;
const DEFAULT_OPTIONS = Object.freeze({
  concurrency: 10,
  attempts: 5,
  backoffMs: 5000,
  batchSize: 50,
});

let cachedHandle = null;

/**
 * Lazily create the queue handle (one per process).
 *
 * @returns {Object} queue handle.
 */
export function getQueue() {
  if (cachedHandle) return cachedHandle;
  cachedHandle = createQueue(QUEUE_NAME, DEFAULT_OPTIONS);
  return cachedHandle;
}

/**
 * Register the consumer that sends queued emails. Sprint 0 is a fail-closed
 * placeholder; Sprint 1 wires the real handler that renders a template from
 * `src/templates/emails/` and sends through `services/email.service.js`,
 * marking records `queued -> sending -> sent | failed`.
 *
 * @param {Function} [_handler] - future: async ({ io }, message) => result
 * @throws {Error} always in Sprint 0.
 */
export async function registerConsumer(_handler) {
  throw new Error(`queue "${QUEUE_NAME}".registerConsumer is not implemented yet (Phase 2 - Sprint 1)`);
}

export default Object.freeze({
  name: QUEUE_NAME,
  description: 'Drains outbound email records in batches and sends them via the mail config.',
  defaultOptions: DEFAULT_OPTIONS,
  getQueue,
  registerConsumer,
});
