/**
 * Email delivery queue contract (placeholder).
 *
 * WHY IT EXISTS
 *   Transactional email and alert notifications should be queued and sent by
 *   a worker (`jobs/email.job.js` polls the queue), decoupling the HTTP
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

const QUEUE_NAME = QUEUE_NAMES.EMAIL_DELIVERY;

/**
 * Register the consumer that sends queued emails.
 * PLACEHOLDER - fails closed. Future implementation renders a template from
 * `src/templates/emails/` and sends through `config/mail.js`, marking records
 * `queued -> sending -> sent | failed`.
 *
 * @param {Function} [_handler] - future: async ({ io }, message) => result
 */
export async function registerConsumer(_handler) {
  throw new Error(`queue "${QUEUE_NAME}".registerConsumer is not implemented yet (Phase 1.1 placeholder)`);
}

export default Object.freeze({
  name: QUEUE_NAME,
  description: 'Drains outbound email records in batches and sends them via the mail config.',
  defaultOptions: Object.freeze({
    concurrency: 10,
    attempts: 5,
    backoffMs: 5000,
    batchSize: 50,
  }),
  registerConsumer,
});
