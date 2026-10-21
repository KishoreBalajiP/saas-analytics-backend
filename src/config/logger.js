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
 *   - Redacts secrets from every log line (roadmap 2.8):
 *       * `LOG_REDACT` paths (exact keys, Pino's fast-redact);
 *       * sensitive keys at ANY depth of a logged object (`formatters.log`
 *         -> `redactDeep`: authorization, cookie, password, *token, *secret,
 *         apiKey, ...);
 *       * credentials inside text (`hooks.streamWrite` -> `redactString` on
 *         the serialised line: bearer tokens, JWTs, `?token=` query values,
 *         `/embed/<token>` and `/webhooks/<token>` paths, URI passwords,
 *         session cookies), which covers messages, stacks and the morgan
 *         access line.
 *   - Adds the active trace context (requestId, traceId, spanId and, inside
 *     queue jobs / scheduled ticks, job / queue / jobId) to every line, so a
 *     request can be followed into the jobs it enqueued.
 *   - Exposes a Morgan-compatible stream so HTTP access logs share the same
 *     pipeline.
 *
 * HOW TO EXTEND
 *   - Change the level per environment in `env.js` (`LOG_LEVEL`).
 *   - Add redaction paths to `LOG_REDACT`; add key or text rules in
 *     `utils/redact.js`.
 *   - Add transports (files, Loki, Datadog, ...) here in one place.
 */

import pino from 'pino';
import env from './env.js';
import { redactDeep, redactString } from '../utils/redact.js';
import { getTraceBindings } from '../utils/traceContext.js';

/** Line listeners (diagnostics and tests); they receive the redacted line. */
const taps = new Set();

/**
 * Observe every serialised log line after redaction (JSON mode). Listeners
 * must be cheap and must not log. Returns an unsubscribe function.
 *
 * @param {(line: string) => void} listener
 * @returns {() => void}
 */
export function addLogTap(listener) {
  taps.add(listener);
  return () => taps.delete(listener);
}

const chindingsSym = pino.symbols.chindingsSym;

/**
 * Trace fields for the current async context. Keys already bound on the
 * (child) logger, e.g. `req.log`'s `requestId`, are skipped so a line never
 * carries the same key twice.
 */
function traceMixin(_mergeObject, _level, instance) {
  const bindings = getTraceBindings();
  if (!bindings) return {};
  const bound = instance?.[chindingsSym];
  const out = {};
  for (const key of Object.keys(bindings)) {
    if (typeof bound === 'string' && bound.includes(`"${key}":`)) continue;
    out[key] = bindings[key];
  }
  return out;
}

/**
 * Merge the log call's fields over the trace fields. A field the call sets
 * to `undefined` (e.g. `{ requestId: job.data.requestId }` when absent) must
 * not erase the trace binding, so only defined values override.
 */
function mergeTraceFields(mergeObject, mixinObject) {
  for (const key of Object.keys(mergeObject)) {
    if (mergeObject[key] !== undefined || !(key in mixinObject)) mixinObject[key] = mergeObject[key];
  }
  return mixinObject;
}

/**
 * Errors keep Pino's standard shape (`type`, `message`, `stack`, own
 * properties), then go through the same deep redaction. A value that is
 * already a plain object (redacted by `formatters.log`) passes unchanged, so
 * the serializer never relabels it.
 */
function serializeError(value) {
  return value instanceof Error ? redactDeep(pino.stdSerializers.err(value)) : value;
}

/** Sensitive keys at any depth; `err` is serialised before redaction. */
function redactLogObject(object) {
  if (object?.err instanceof Error) {
    return redactDeep({ ...object, err: pino.stdSerializers.err(object.err) });
  }
  return redactDeep(object);
}

/** Final pass over the serialised line: mask credentials in any text. */
function redactLine(line) {
  const safe = redactString(line);
  if (taps.size > 0) {
    for (const tap of taps) {
      try {
        tap(safe);
      } catch {
        // a broken listener must never break logging
      }
    }
  }
  return safe;
}

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
  mixin: traceMixin,
  mixinMergeStrategy: mergeTraceFields,
  serializers: {
    err: serializeError,
  },
  formatters: {
    // Sensitive keys at any depth (Pino's paths only cover exact keys).
    log: redactLogObject,
  },
  hooks: {
    streamWrite: redactLine,
  },
};

let logger;

// Node's test runner exposes NODE_TEST_CONTEXT even when the suite keeps
// NODE_ENV=development for environment-specific assertions. Treat that
// process as a structured-logging test process too; pino-pretty's worker
// transport otherwise leaves an IPC handle open after integration teardown.
if (env.app.isProduction || env.app.isTest || process.env.NODE_TEST_CONTEXT) {
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
