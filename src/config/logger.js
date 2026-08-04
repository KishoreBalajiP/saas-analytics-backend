/**
 * Application logger.
 *
 * WHY IT EXISTS
 *   Produces structured, machine-parseable logs with different behaviour per
 *   environment. All other modules should import from `utils/logger.js`
 *   (this file is the configuration/creation point).
 *
 * RESPONSIBILITY
 *   - Creates a Pino logger instance.
 *   - Pretty human-readable output in development; pure JSON in production
 *     and test so external collectors can consume it.
 *   - Redacts secrets (tokens, cookies, passwords) from every log line.
 *   - Exposes a Morgan-compatible stream so HTTP access logs share the same
 *     pipeline.
 *
 * HOW TO EXTEND
 *   - Change the level per environment in `env.js` (`LOG_LEVEL`).
 *   - Add redaction paths to `LOG_REDACT`.
 *   - Add transports (files, Loki, Datadog, ...) here in one place.
 */

import pino from 'pino';
import env from './env.js';

const baseOptions = {
  level: env.logging.level,
  redact: {
    paths: env.logging.redact,
    censor: '[REDACTED]',
  },
  base: {
    service: env.app.name,
    env: env.app.env,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

let logger;

if (env.app.isProduction || env.app.isTest) {
  // JSON only - ideal for stdout collectors (Fly, Render, CloudWatch, ECS).
  logger = pino(baseOptions);
} else {
  // Pretty, colourised output for local development.
  logger = pino({
    ...baseOptions,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname,service,env',
      },
    },
  });
}

/**
 * Morgan-compatible write stream. HTTP access logs are emitted through Pino
 * so every request is logged consistently with the rest of the system.
 */
export const httpLoggerStream = {
  write(message) {
    logger.info({ http: 'access' }, message.trim());
  },
};

export { logger };
export default logger;
