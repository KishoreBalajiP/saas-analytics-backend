/**
 * Mail transport factory.
 *
 * WHY IT EXISTS
 *   Centralises every transport decision so feature code can call
 *   `services/email.service.js#send()` and never know whether delivery is
 *   via SMTP, a transactional provider (SES, Postmark, Resend) or a stub.
 *
 * RESPONSIBILITY
 *   - Build a `nodemailer` transport from configuration.
 *   - Provide a `noop` transport for tests and when mail is disabled.
 *
 * DESIGN CONSTRAINTS
 *   - Credentials come from env/config only - never from code or logs.
 *   - The factory is lazy: the first call to `createMailer()` opens the
 *     SMTP connection; subsequent calls reuse it.
 *
 * HOW TO EXTEND
 *   Add a new transport (e.g. `ses`) by extending `createMailer()` with a
 *   new branch on `env.mail.provider`.
 */

import nodemailer from 'nodemailer';
import env from '../config/env.js';

const TRANSPORT_TYPES = Object.freeze({
  SMTP: 'smtp',
  NOOP: 'noop',
});

/**
 * Determine the effective transport type based on configuration.
 *
 * Returns `noop` whenever mail is disabled (`MAIL_PROVIDER=none`) OR
 * SMTP has not been configured with a host. This is the safe default in
 * development so the application boots without an SMTP server and tests
 * can capture outgoing messages without sending them.
 *
 * @returns {string} transport type.
 */
function resolveType() {
  const provider = (env.mail.provider ?? 'none').toLowerCase();
  if (provider === 'none') return TRANSPORT_TYPES.NOOP;
  if (!env.mail.host) return TRANSPORT_TYPES.NOOP;
  if (provider === TRANSPORT_TYPES.SMTP) return TRANSPORT_TYPES.SMTP;
  // Future: 'ses', 'postmark', 'resend' - route through a transport
  // adapter in Sprint 1+ when transactional email lands.
  return TRANSPORT_TYPES.SMTP;
}

/**
 * Expose the effective transport type so callers can tell real delivery
 * (SMTP) apart from the in-memory `noop` stub. Feature code must use this to
 * avoid reporting a message as "sent" when nothing left the process.
 *
 * @returns {string} transport type (`smtp` | `noop`).
 */
export function getTransportType() {
  return resolveType();
}

/**
 * Whether a real, configurable transport is available for delivery.
 *
 * @returns {boolean} true only when SMTP is fully configured.
 */
export function isDeliveryConfigured() {
  return resolveType() === TRANSPORT_TYPES.SMTP;
}

/**
 * Build the SMTP transport options from a mail config. Exported so the
 * timeout settings can be asserted without opening a connection.
 *
 * Timeouts (finding ops2.12): nodemailer's defaults are minutes, so a
 * blocked or slow SMTP egress would hang the caller. Bounded timeouts make
 * a send fail fast; the email outbox then retries it with backoff.
 *
 * @param {Object} [mail=env.mail]
 * @returns {Object} nodemailer SMTP transport options.
 */
export function buildSmtpOptions(mail = env.mail) {
  return {
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    auth: mail.user || mail.password
      ? { user: mail.user, pass: mail.password }
      : undefined,
    pool: true,
    maxConnections: 5,
    // Time to establish the TCP connection.
    connectionTimeout: mail.connectionTimeoutMs ?? 10000,
    // Time to wait for the server greeting once connected.
    greetingTimeout: mail.greetingTimeoutMs ?? 10000,
    // Idle time allowed on the socket during a send.
    socketTimeout: mail.socketTimeoutMs ?? 20000,
  };
}

/**
 * Create a `nodemailer` transport for the configured provider.
 *
 * @returns {object} nodemailer transport.
 */
export function createMailer() {
  const type = resolveType();
  if (type === TRANSPORT_TYPES.NOOP) {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  return nodemailer.createTransport(buildSmtpOptions(env.mail));
}

/**
 * Build a noop mailer for tests and when mail is disabled. Outgoing
 * messages are collected in memory and never sent.
 *
 * @returns {{ transport: object, sent: Array }}
 */
export function createNoopMailer() {
  const sent = [];
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const originalSendMail = transport.sendMail.bind(transport);
  transport.sendMail = async (options) => {
    sent.push(options);
    return originalSendMail(options);
  };
  return { transport, sent };
}

export default {
  buildSmtpOptions,
  createMailer,
  createNoopMailer,
  getTransportType,
  isDeliveryConfigured,
  TRANSPORT_TYPES,
};
