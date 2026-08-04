/**
 * Mail configuration.
 *
 * WHY IT EXISTS
 *   Holds the SMTP/mail-provider settings so future email features (welcome
 *   messages, alerts, digests) plug into a ready-made configuration. No mail
 *   is sent in Phase 1.
 *
 * RESPONSIBILITY
 *   - Expose provider credentials and sender details from `.env`.
 *   - Warn loudly in production when mail is not configured yet.
 *
 * HOW TO EXTEND
 *   - Switch providers by changing `MAIL_PROVIDER` (smtp / resend / sendgrid
 *     ...) and adding a small transport factory here when a mail library is
 *     introduced (e.g. nodemailer).
 *   - The `jobs/email.job.js` stub already documents the expected integration
 *     point.
 */

import env from './env.js';
import logger from './logger.js';

const isConfigured = () =>
  env.mail.provider !== 'none' &&
  Boolean(env.mail.host || env.mail.user || env.mail.password);

if (env.app.isProduction && !isConfigured()) {
  logger.warn(
    { provider: env.mail.provider },
    'Mail is not configured. Set MAIL_* variables before enabling email features.',
  );
}

export default {
  provider: env.mail.provider,
  host: env.mail.host,
  port: env.mail.port,
  secure: env.mail.secure,
  auth: {
    user: env.mail.user,
    pass: env.mail.password,
  },
  from: env.mail.from,
  isConfigured,
};
