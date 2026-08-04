/**
 * Email service - the only public interface for sending email.
 *
 * WHY IT EXISTS
 *   Feature code (auth, notifications, governance) must never import
 *   `nodemailer` or build a transport themselves. They call this service
 *   which:
 *     1. Lazily creates a `nodemailer` transport on first send.
 *     2. Validates the envelope (from/to/subject/text/html).
 *     3. Returns a typed result so the caller can decide whether to retry.
 *
 * RESPONSIBILITY
 *   - Lazy transport resolution.
 *   - Send a single message or many in parallel.
 *   - Lifecycle: `close()` to flush the SMTP pool.
 *
 * DESIGN CONSTRAINTS
 *   - When `MAIL_PROVIDER=none` (or mail is unconfigured in dev), sends are
 *     routed through a `jsonTransport` so tests can capture and assert.
 *   - The service NEVER logs raw message bodies; only metadata.
 *
 * HOW TO EXTEND
 *   Add a templated helper (e.g. `sendWelcome({ to })`) by composing
 *   `send()` with a template registry.
 */

import { createMailer, createNoopMailer } from './mail.transport.js';
import logger from '../utils/logger.js';

let transport = null;
let captureSink = null;

/* -------------------------------- errors -------------------------------- */

/**
 * Typed error so callers can map email failures to HTTP responses.
 */
export class EmailError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmailError';
    this.code = code;
    this.isOperational = true;
  }
}

/* ------------------------------ lifecycle ------------------------------- */

/**
 * Initialise the email transport. Idempotent.
 *
 * @returns {object} the nodemailer transport.
 */
export function init() {
  if (transport) return transport;
  transport = createMailer();
  return transport;
}

/**
 * Close the email transport (releases the SMTP pool).
 *
 * @returns {Promise<void>}
 */
export async function close() {
  if (!transport) return;
  try {
    transport.close?.();
  } finally {
    transport = null;
    captureSink = null;
  }
}

/**
 * Return the underlying transport (lazy init). Useful for tests and
 * advanced integrations.
 *
 * @returns {object}
 */
export function getTransport() {
  return init();
}

/**
 * Install a capture sink so `send()` records messages instead of delivering
 * them. Primarily for tests.
 *
 * @param {Array} sink - an array that will receive sent messages.
 */
export function captureInto(sink) {
  captureSink = sink;
}

/**
 * Stop capturing messages. Subsequent sends go to the configured transport.
 */
export function stopCapture() {
  captureSink = null;
}

/* -------------------------------- API ----------------------------------- */

/**
 * Send a single email message. Returns the SMTP response (`info`).
 *
 * @param {Object} message - { from?, to, subject, text?, html?, cc?, bcc?, replyTo?, headers? }.
 * @returns {Promise<{ messageId: string, accepted: string[], rejected: string[], response: object }>}
 */
export async function send(message) {
  validate(message);
  const transport = init();
  const envelope = {
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    replyTo: message.replyTo,
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: message.headers,
  };
  try {
    const info = await transport.sendMail(envelope);
    if (captureSink) captureSink.push({ ...envelope, messageId: info.messageId });
    logger.debug(
      { messageId: info.messageId, to: normaliseAddresses(message.to) },
      'email sent',
    );
    return {
      messageId: info.messageId,
      accepted: info.accepted ?? [],
      rejected: info.rejected ?? [],
      response: info,
    };
  } catch (err) {
    logger.error(
      { err: { message: err?.message }, to: normaliseAddresses(message.to) },
      'email send failed',
    );
    throw new EmailError('SEND_FAILED', err?.message ?? 'Email send failed');
  }
}

/**
 * Send many emails in parallel. Failures are collected and returned; the
 * caller decides whether to retry.
 *
 * @param {Object[]} messages
 * @returns {Promise<{ sent: any[], failed: Array<{ index: number, error: Error }> }>}
 */
export async function sendMany(messages) {
  if (!Array.isArray(messages)) {
    throw new EmailError('INVALID_INPUT', 'sendMany requires an array');
  }
  const results = await Promise.allSettled(messages.map((m) => send(m)));
  const sent = [];
  const failed = [];
  results.forEach((r, index) => {
    if (r.status === 'fulfilled') sent.push({ index, ...r.value });
    else failed.push({ index, error: r.reason });
  });
  return { sent, failed };
}

/**
 * Verify the configured transport by issuing a no-op SMTP probe. Returns
 * `true` on success, throws `EmailError` otherwise.
 *
 * @returns {Promise<boolean>}
 */
export async function verify() {
  const transport = init();
  try {
    await transport.verify();
    return true;
  } catch (err) {
    throw new EmailError('VERIFY_FAILED', err?.message ?? 'Transport verification failed');
  }
}

/* -------------------------------- helpers -------------------------------- */

/**
 * Validate the minimum envelope required to send a message.
 *
 * @param {Object} message
 */
function validate(message) {
  if (!message || typeof message !== 'object') {
    throw new EmailError('INVALID_INPUT', 'email message must be an object');
  }
  if (!message.to) {
    throw new EmailError('INVALID_INPUT', 'email message requires `to`');
  }
  if (!message.subject) {
    throw new EmailError('INVALID_INPUT', 'email message requires `subject`');
  }
  if (!message.text && !message.html) {
    throw new EmailError('INVALID_INPUT', 'email message requires `text` or `html`');
  }
}

/**
 * Coerce the `to` field into a stable, loggable array of addresses.
 *
 * @param {string|string[]} value
 * @returns {string[]}
 */
function normaliseAddresses(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}

// Re-export the noop factory so tests can build their own capture sinks
// without importing `mail.transport.js` directly.
export { createNoopMailer };

export default {
  init,
  close,
  getTransport,
  captureInto,
  stopCapture,
  send,
  sendMany,
  verify,
  EmailError,
  createNoopMailer,
};
