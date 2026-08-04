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
 * Create a `nodemailer` transport for the configured provider.
 *
 * @returns {object} nodemailer transport.
 */
export function createMailer() {
  const type = resolveType();
  if (type === TRANSPORT_TYPES.NOOP) {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  return nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.secure,
    auth: env.mail.user || env.mail.password
      ? { user: env.mail.user, pass: env.mail.password }
      : undefined,
    pool: true,
    maxConnections: 5,
  });
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

export default { createMailer, createNoopMailer, TRANSPORT_TYPES };
