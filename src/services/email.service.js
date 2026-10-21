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
 *   Feature code should not call `send()` for transactional mail: enqueue it
 *   through the email outbox (`services/outbox.service.js#enqueueEmail`, or
 *   `sendNow` for interactive mail that should go out within the request),
 *   which renders a template from `src/templates/emails/` via
 *   `renderTemplate()`, retries with backoff and dead-letters failures.
 */

import env from '../config/env.js';
import {
  createMailer,
  createNoopMailer,
  getTransportType as transportGetTransportType,
  isDeliveryConfigured as transportIsDeliveryConfigured,
} from './mail.transport.js';
import logger from '../utils/logger.js';
import { render as renderEmailTemplate } from './emailTemplate.service.js';
// observability: email_sends_total{outcome} (roadmap 2.8).
import { observeEmailSend } from '../utils/metrics.js';

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

/**
 * Whether a real transport is configured for delivery. `false` means sends
 * are routed through the in-memory `noop` stub and nothing is delivered.
 *
 * @returns {boolean}
 */
export function isDeliveryConfigured() {
  return transportIsDeliveryConfigured();
}

/**
 * Whether a capture sink is installed (tests) so sends are recorded rather
 * than delivered over the network.
 *
 * @returns {boolean}
 */
export function isCapturing() {
  return captureSink !== null;
}

/**
 * Effective transport type (`smtp` | `noop`), for health reporting.
 *
 * @returns {string}
 */
export function getTransportType() {
  return transportGetTransportType();
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
    // Every message needs a sender. Callers (verification, invitations,
    // password reset, alerts) do not set one, so fall back to MAIL_FROM;
    // without it many SMTP providers reject or rewrite the message.
    from: message.from || env.mail.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    replyTo: message.replyTo,
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: message.headers,
    // retention: the outbox sets a stable Message-ID per outbox record (so a
    // receiver can de-duplicate a resend after a crash) and may attach
    // stored artefacts.
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(Array.isArray(message.attachments) && message.attachments.length > 0
      ? { attachments: message.attachments }
      : {}),
  };
  try {
    const info = await transport.sendMail(envelope);
    observeEmailSend('sent');
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
    observeEmailSend('failed');
    logger.error(
      { err: { message: err?.message }, to: normaliseAddresses(message.to) },
      'email send failed',
    );
    throw new EmailError('SEND_FAILED', err?.message ?? 'Email send failed');
  }
}

/**
 * Render a transactional template into `{ subject, text, html? }`. The email
 * outbox renders through this at send time: the platform-admin override
 * (`/api/v1/email-templates`, roadmap 2.4) when one is active for `locale`,
 * the built-in from `src/templates/emails/index.js` otherwise.
 *
 * @param {string} template - template key, e.g. `auth.password_reset`.
 * @param {Object} [variables]
 * @param {{ locale?: string }} [options]
 * @returns {Promise<{ subject: string, text: string, html?: string }>}
 * @throws {Error} with `code` and `field` (first invalid variable) when the
 *   template is unknown or a required variable is missing.
 */
export async function renderTemplate(template, variables = {}, { locale = 'en' } = {}) {
  try {
    const rendered = await renderEmailTemplate(template, variables, { locale });
    return { subject: rendered.subject, text: rendered.text, ...(rendered.html ? { html: rendered.html } : {}) };
  } catch (err) {
    const first = Array.isArray(err?.errors) ? err.errors[0]?.field : null;
    if (first && String(first).startsWith('variables.')) err.field = String(first).slice('variables.'.length);
    throw err;
  }
}

/**
 * Render a registered transactional template and send it. Uses the active
 * platform-admin override for `locale` when there is one, the built-in
 * otherwise. Variable values are never logged.
 *
 * @param {Object} message - { to, template, variables?, locale?, cc?, bcc?, replyTo?, headers?, from? }.
 * @returns {Promise<{ messageId: string, accepted: string[], rejected: string[], response: object, template: { key: string, source: string, version: number } }>}
 * @throws {EmailError} TEMPLATE_INVALID (unknown template / missing required variable) or SEND_FAILED.
 */
export async function sendTemplate({ template, variables = {}, locale = 'en', ...message } = {}) {
  let rendered;
  try {
    rendered = await renderEmailTemplate(template, variables, { locale });
  } catch (err) {
    logger.error({ template, code: err?.code }, 'email template render failed');
    throw new EmailError('TEMPLATE_INVALID', err?.message ?? 'Email template could not be rendered');
  }
  const info = await send({
    ...message,
    subject: rendered.subject,
    text: rendered.text,
    ...(rendered.html ? { html: rendered.html } : {}),
  });
  return { ...info, template: { key: template, source: rendered.source, version: rendered.version } };
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
export async function verify({ timeoutMs = env.mail.verifyTimeoutMs ?? 5000 } = {}) {
  const transport = init();
  let timer;
  try {
    // Bounded: a blocked SMTP egress must not hang a health probe.
    await Promise.race([
      transport.verify(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new EmailError('VERIFY_TIMEOUT', 'Transport verification timed out')), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return true;
  } catch (err) {
    if (err instanceof EmailError) throw err;
    throw new EmailError('VERIFY_FAILED', err?.message ?? 'Transport verification failed');
  } finally {
    clearTimeout(timer);
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
  isDeliveryConfigured,
  isCapturing,
  getTransportType,
  renderTemplate,
  send,
  sendTemplate,
  sendMany,
  verify,
  EmailError,
  createNoopMailer,
};
