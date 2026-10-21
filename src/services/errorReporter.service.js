/**
 * Error reporter: pluggable error aggregation (roadmap 2.8, findings ops.07,
 * ops2.05, ops.15).
 *
 * WHY IT EXISTS
 *   A 500, a failed scheduled job, a queue job that ran out of retries, an
 *   uncaught exception or a frontend crash must reach an error tracker where
 *   it can raise an alert, not only a log line someone has to search for.
 *   This module is the one place every source hands errors to, behind a sink
 *   chosen by configuration.
 *
 * SINKS (`ERROR_REPORTER`)
 *   - `none` (default) - events are counted in metrics and dropped.
 *   - `log`            - one structured `error` log line per event (useful
 *                        when logs already ship to a collector).
 *   - `http`           - POST the event as JSON to `ERROR_REPORTER_URL` with
 *                        an optional bearer token (any webhook-style intake:
 *                        a Sentry/GlitchTip relay, a Slack/PagerDuty bridge,
 *                        a log intake).
 *   Tests and integrations can install their own sink with `setErrorSink`.
 *
 * GUARANTEES
 *   - Never throws and never blocks the caller: delivery is asynchronous,
 *     bounded by a timeout, and failures are counted, not rethrown.
 *   - Scrubbed: every event goes through `redactDeep` (sensitive keys at any
 *     depth, bearer tokens, JWTs, URL tokens, URI passwords, cookies) and
 *     PII masking (email addresses, IP addresses, values under personal-data
 *     keys) before it leaves the process.
 *   - Bounded: the same fingerprint is delivered at most once per dedupe
 *     window (repeats are counted into the next event), at most
 *     `maxEventsPerMinute` events leave per minute, and at most
 *     MAX_PENDING deliveries are in flight.
 *
 * EVENT SHAPE
 *   { id, timestamp, level, source, fingerprint, occurrences,
 *     error: { type, message, code, statusCode, stack },
 *     request?: { method, route, path, requestId, traceId },
 *     trace?: { requestId, traceId, spanId, job, queue, jobId },
 *     context?: { ...small, scrubbed },
 *     service: { name, version, env, role, instanceId } }
 */

import { randomUUID, createHash } from 'node:crypto';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import { redactDeep, redactUrl, REDACTED } from '../utils/redact.js';
import { getTraceBindings } from '../utils/traceContext.js';
import { errorReportsTotal } from '../utils/metrics.js';

export const ERROR_SOURCES = Object.freeze(['api', 'job', 'queue', 'process', 'frontend']);
export const MAX_PENDING = 100;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_STACK_LENGTH = 8000;
const MAX_CONTEXT_JSON = 4000;
const PII_REPLACEMENT = '[PII]';

/* ------------------------------- scrubbing ------------------------------- */

// Bounded quantifiers keep scrubbing linear on long strings (RFC limits:
// 64-character local part, 253-character domain).
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const IPV4_PATTERN = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
/** Normalised keys whose values identify a person. */
const PII_KEYS = new Set([
  'email',
  'emails',
  'to',
  'cc',
  'bcc',
  'replyto',
  'phone',
  'phonenumber',
  'mobile',
  'ip',
  'ipaddress',
  'remoteaddress',
  'xforwardedfor',
  'firstname',
  'lastname',
  'fullname',
  'address',
  'dob',
  'dateofbirth',
  'useragent',
]);

function maskPiiText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(EMAIL_PATTERN, PII_REPLACEMENT).replace(IPV4_PATTERN, PII_REPLACEMENT);
}

function maskPii(value, depth = 0) {
  if (typeof value === 'string') return maskPiiText(value);
  if (value === null || typeof value !== 'object' || depth > 10) return value;
  if (Array.isArray(value)) return value.map((item) => maskPii(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const normalised = key.toLowerCase().replace(/[-_]/g, '');
    out[key] = PII_KEYS.has(normalised) && item !== null && item !== undefined && typeof item !== 'boolean'
      ? PII_REPLACEMENT
      : maskPii(item, depth + 1);
  }
  return out;
}

/**
 * Remove secrets and personal data from an event (or any value): sensitive
 * keys and credentials in text first, then PII. The input is not mutated.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function scrubEvent(value) {
  return maskPii(redactDeep(value, { maxDepth: 8 }));
}

function truncate(text, max) {
  if (typeof text !== 'string') return text;
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

/** Keep context small: oversized context is replaced by a marker. */
function boundContext(context) {
  if (!context || typeof context !== 'object') return undefined;
  try {
    const json = JSON.stringify(context);
    return json.length > MAX_CONTEXT_JSON ? { truncated: true } : context;
  } catch {
    return { unserialisable: true };
  }
}

/* ------------------------------ event build ------------------------------ */

/** Runtime frames that vary with scheduling, not with the failing code. */
const NOISE_FRAME = /\(node:|at node:|node_modules|processTicksAndRejections|runInAsyncScope|new Promise \(<anonymous>\)/;

function stackHead(stack) {
  if (typeof stack !== 'string') return '';
  return stack
    .split('\n')
    .slice(1)
    .filter((line) => line.trim().startsWith('at ') && !NOISE_FRAME.test(line))
    .slice(0, 3)
    .map((line) => line.trim().replace(/:\d+:\d+\)?$/, ''))
    .join('|');
}

/**
 * Stable grouping key: source, error type/code and the top stack frames
 * (line/column stripped so a redeploy does not split groups), or the
 * message when there is no stack.
 */
export function fingerprintOf({ source, type, code, message, stack, route }) {
  const basis = [source, type, code ?? '', route ?? '', stackHead(stack) || String(message ?? '').slice(0, 200)].join('#');
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

function serviceInfo() {
  return {
    name: env.app.name,
    version: env.app.version,
    env: env.app.env,
    role: env.runtime?.role ?? 'all',
    instanceId: env.runtime?.instanceId || null,
  };
}

/**
 * Build a scrubbed event from an error and its context.
 *
 * @param {unknown} error
 * @param {Object} [context]
 * @param {string} [context.source='api'] - one of ERROR_SOURCES.
 * @param {'error'|'fatal'|'warning'} [context.level='error']
 * @param {import('express').Request} [context.req] - request to summarise.
 * @param {string} [context.route] - route template (metrics label).
 * @param {Object} [context.extra] - small extra context (scrubbed).
 * @returns {Object}
 */
export function buildErrorEvent(error, { source = 'api', level = 'error', req, route, extra } = {}) {
  const err = error instanceof Error ? error : null;
  const type = err?.name ?? (typeof error === 'object' && error?.type ? String(error.type) : 'Error');
  const message = truncate(
    err ? String(err.message ?? '') : typeof error === 'string' ? error : String(error?.message ?? error ?? ''),
    MAX_MESSAGE_LENGTH,
  );
  const stack = truncate(err?.stack ?? (typeof error?.stack === 'string' ? error.stack : undefined), MAX_STACK_LENGTH);
  const code = typeof error?.code === 'string' || typeof error?.code === 'number' ? String(error.code) : undefined;
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : undefined;
  const trace = getTraceBindings() ?? undefined;

  const event = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    source: ERROR_SOURCES.includes(source) ? source : 'api',
    fingerprint: fingerprintOf({ source, type, code, message, stack, route }),
    occurrences: 1,
    error: { type, message, ...(code ? { code } : {}), ...(statusCode ? { statusCode } : {}), ...(stack ? { stack } : {}) },
    ...(trace ? { trace: { ...trace } } : {}),
    service: serviceInfo(),
  };
  if (req) {
    event.request = {
      method: req.method,
      ...(route ? { route } : {}),
      path: redactUrl(String(req.originalUrl ?? req.url ?? '').split('?')[0]),
      requestId: req.id ?? null,
    };
  }
  const bounded = boundContext(extra);
  if (bounded) event.context = bounded;
  return scrubEvent(event);
}

/* --------------------------------- sinks --------------------------------- */

/** Drops everything (default). */
export const noopSink = Object.freeze({ name: 'none', async send() { return 'noop'; } });

/** Writes each event as one structured error log line. */
export const logSink = Object.freeze({
  name: 'log',
  async send(event) {
    logger.error({ errorReport: event }, `error report: ${event.error?.type ?? 'Error'}`);
    return 'sent';
  },
});

/**
 * HTTP sink: POST the event as JSON. Bounded by `timeoutMs`; a non-2xx
 * answer or a network failure counts as `failed`.
 *
 * @param {Object} options
 * @param {string} options.url
 * @param {string} [options.token]
 * @param {number} [options.timeoutMs=3000]
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests.
 */
export function createHttpSink({ url, token, timeoutMs = 3000, fetchImpl = globalThis.fetch } = {}) {
  if (!url) throw new Error('createHttpSink requires a url');
  return Object.freeze({
    name: 'http',
    async send(event) {
      const headers = { 'content-type': 'application/json', 'user-agent': `${env.app.name}/${env.app.version} error-reporter` };
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
        redirect: 'error',
      });
      // Drain the body so the socket is released.
      await response.arrayBuffer?.().catch(() => null);
      if (!response.ok) throw new Error(`error sink answered ${response.status}`);
      return 'sent';
    },
  });
}

function sinkFromConfig() {
  const cfg = env.observability?.errorReporter ?? {};
  if (cfg.sink === 'http' && cfg.url) {
    return createHttpSink({ url: cfg.url, token: cfg.token, timeoutMs: cfg.timeoutMs });
  }
  if (cfg.sink === 'log') return logSink;
  return noopSink;
}

/* -------------------------------- reporter -------------------------------- */

let sink = sinkFromConfig();
let limits = {
  maxEventsPerMinute: env.observability?.errorReporter?.maxEventsPerMinute ?? 60,
  dedupeWindowMs: env.observability?.errorReporter?.dedupeWindowMs ?? 60000,
};
/** fingerprint -> { lastSentAt, suppressed } */
const seen = new Map();
let windowStartedAt = 0;
let sentInWindow = 0;
const pending = new Set();

function count(source, result) {
  errorReportsTotal.inc({ source, result });
}

/**
 * Install a sink (tests, integrations). Returns the previous one.
 *
 * @param {{ name: string, send: (event: Object) => Promise<string> }} next
 */
export function setErrorSink(next) {
  if (!next || typeof next.send !== 'function') throw new TypeError('setErrorSink requires { send(event) }');
  const previous = sink;
  sink = next;
  return previous;
}

/** The active sink. */
export function getErrorSink() {
  return sink;
}

/** Test hook: restore configured sink and limits, forget dedupe state. */
export function resetErrorReporter({ maxEventsPerMinute, dedupeWindowMs } = {}) {
  sink = sinkFromConfig();
  limits = {
    maxEventsPerMinute: maxEventsPerMinute ?? env.observability?.errorReporter?.maxEventsPerMinute ?? 60,
    dedupeWindowMs: dedupeWindowMs ?? env.observability?.errorReporter?.dedupeWindowMs ?? 60000,
  };
  seen.clear();
  windowStartedAt = 0;
  sentInWindow = 0;
}

/** Decide whether an event may leave now; returns the occurrences to report or 0. */
function admit(event, now) {
  const entry = seen.get(event.fingerprint);
  if (entry && now - entry.lastSentAt < limits.dedupeWindowMs) {
    entry.suppressed += 1;
    return 0;
  }
  if (now - windowStartedAt >= 60000) {
    windowStartedAt = now;
    sentInWindow = 0;
  }
  if (sentInWindow >= limits.maxEventsPerMinute || pending.size >= MAX_PENDING) return -1;
  sentInWindow += 1;
  const occurrences = 1 + (entry?.suppressed ?? 0);
  seen.set(event.fingerprint, { lastSentAt: now, suppressed: 0 });
  // Bound the dedupe map: forget the oldest entries.
  if (seen.size > 1000) {
    const oldest = seen.keys().next().value;
    seen.delete(oldest);
  }
  return occurrences;
}

/**
 * Hand a built event to the sink (fire-and-forget). Returns the delivery
 * promise, which never rejects (tests may await it).
 *
 * @param {Object} event - from `buildErrorEvent` (or an already scrubbed event).
 * @returns {Promise<string>} 'sent' | 'noop' | 'dropped' | 'deduped' | 'failed'
 */
export function reportEvent(event) {
  const source = ERROR_SOURCES.includes(event?.source) ? event.source : 'api';
  if (sink === noopSink) {
    count(source, 'noop');
    return Promise.resolve('noop');
  }
  const admitted = admit(event, Date.now());
  if (admitted === 0) {
    count(source, 'deduped');
    return Promise.resolve('deduped');
  }
  if (admitted < 0) {
    count(source, 'dropped');
    return Promise.resolve('dropped');
  }
  const payload = { ...event, occurrences: admitted };
  const delivery = Promise.resolve()
    .then(() => sink.send(payload))
    .then((result) => {
      const outcome = result === 'noop' ? 'noop' : 'sent';
      count(source, outcome);
      return outcome;
    })
    .catch((err) => {
      count(source, 'failed');
      // Never log the payload or the sink URL; the reason is enough.
      logger.warn({ err: { message: err?.message }, sink: sink.name, source }, 'error report delivery failed');
      return 'failed';
    })
    .finally(() => pending.delete(delivery));
  pending.add(delivery);
  return delivery;
}

/**
 * Report an error. Never throws.
 *
 * @param {unknown} error
 * @param {Object} [context] - see `buildErrorEvent`.
 * @returns {Promise<string>} delivery outcome (never rejects).
 */
export function reportError(error, context = {}) {
  try {
    return reportEvent(buildErrorEvent(error, context));
  } catch (err) {
    logger.warn({ err: { message: err?.message } }, 'error report could not be built');
    return Promise.resolve('failed');
  }
}

/**
 * Wait (bounded) for in-flight deliveries, e.g. before process exit.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=2000]
 * @returns {Promise<boolean>} true when everything settled in time.
 */
export async function flushErrorReports({ timeoutMs = 2000 } = {}) {
  if (pending.size === 0) return true;
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.allSettled(Array.from(pending)).then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export { REDACTED, PII_REPLACEMENT };

export default {
  reportError,
  reportEvent,
  buildErrorEvent,
  scrubEvent,
  fingerprintOf,
  setErrorSink,
  getErrorSink,
  resetErrorReporter,
  flushErrorReports,
  createHttpSink,
  noopSink,
  logSink,
  ERROR_SOURCES,
};
