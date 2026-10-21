/**
 * Trace context: request id + W3C trace context carried across async work
 * (roadmap 2.8, findings ops2.14 / ops.15).
 *
 * WHY IT EXISTS
 *   A support ticket quotes a request id; an operator needs every log line
 *   that request produced, including lines written by queue jobs it
 *   enqueued and by services that log through the global logger (not
 *   `req.log`). AsyncLocalStorage carries the context through every await,
 *   the logger mixes it into each line, and queue producers copy it into
 *   the job so the consumer continues the same trace.
 *
 * RESPONSIBILITY
 *   - `normalizeRequestId(value)`   accept a client-supplied X-Request-Id only
 *                                   when it is 8-128 safe characters.
 *   - `parseTraceparent(header)`    W3C `traceparent` (version 00) parser.
 *   - `formatTraceparent(ctx)`      build the header for outbound calls.
 *   - `runWithTrace(ctx, fn)`       run `fn` inside a trace context.
 *   - `getTraceContext()`           the active context (or undefined).
 *   - `getTraceBindings()`          the fields the logger adds to each line.
 *   - `currentTraceCarrier()`       the serialisable part a job carries.
 *   - `childTraceContext(carrier, extra)` the context a job runs in.
 *
 * DESIGN
 *   Dependency-free (no logger import) so `config/logger.js` can use it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

const storage = new AsyncLocalStorage();

/** Client-supplied request ids: 8-128 chars, starting alphanumeric. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

/**
 * Validate an inbound request id. Anything else (empty, too long, spaces,
 * control or quote characters) is rejected so a caller cannot forge log
 * structure or collide with ids the server generates.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeRequestId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** 32 lower-case hex characters (W3C trace-id). */
export function newTraceId() {
  return randomBytes(16).toString('hex');
}

/** 16 lower-case hex characters (W3C parent-id / span id). */
export function newSpanId() {
  return randomBytes(8).toString('hex');
}

/**
 * Parse a W3C `traceparent` header. Returns null for anything malformed,
 * the forbidden version `ff`, or all-zero ids.
 *
 * @param {unknown} header
 * @returns {{ traceId: string, parentSpanId: string, flags: string }|null}
 */
export function parseTraceparent(header) {
  if (typeof header !== 'string' || header.length > 512) return null;
  const match = TRACEPARENT_PATTERN.exec(header.trim().toLowerCase());
  if (!match) return null;
  const [, version, traceId, parentSpanId, flags] = match;
  if (version === 'ff') return null;
  // Version 00 has exactly four fields; later versions may append more.
  if (version === '00' && header.trim().length !== 55) return null;
  if (traceId === ZERO_TRACE_ID || parentSpanId === ZERO_SPAN_ID) return null;
  return { traceId, parentSpanId, flags };
}

/**
 * Build a `traceparent` header value for an outbound call made inside
 * `ctx` (the current span becomes the callee's parent).
 *
 * @param {{ traceId: string, spanId: string, flags?: string }} ctx
 * @returns {string|null}
 */
export function formatTraceparent(ctx) {
  if (!ctx?.traceId || !ctx?.spanId) return null;
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.flags ?? '01'}`;
}

/**
 * Run `fn` inside a trace context. The context object is frozen so nested
 * code cannot change the request it belongs to.
 *
 * @template T
 * @param {Object} ctx - `{ requestId?, traceId, spanId, parentSpanId?, flags?, ...extra }`.
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithTrace(ctx, fn) {
  const context = Object.freeze({
    ...ctx,
    traceId: ctx?.traceId ?? newTraceId(),
    spanId: ctx?.spanId ?? newSpanId(),
    flags: ctx?.flags ?? '01',
  });
  return storage.run(context, fn);
}

/** The active trace context, if any. */
export function getTraceContext() {
  return storage.getStore();
}

/** Fields that identify the active context in log lines (cached per context). */
const bindingCache = new WeakMap();
const BINDING_KEYS = ['requestId', 'traceId', 'spanId', 'job', 'queue', 'jobId'];

/**
 * Log bindings for the active context: requestId, traceId, spanId and, inside
 * jobs, job / queue / jobId. Returns null outside any context.
 *
 * @returns {Object|null}
 */
export function getTraceBindings() {
  const ctx = storage.getStore();
  if (!ctx) return null;
  let bindings = bindingCache.get(ctx);
  if (!bindings) {
    bindings = {};
    for (const key of BINDING_KEYS) {
      if (ctx[key] !== undefined && ctx[key] !== null) bindings[key] = ctx[key];
    }
    bindings = Object.freeze(bindings);
    bindingCache.set(ctx, bindings);
  }
  return bindings;
}

/**
 * The serialisable part of the active context that a queued job carries
 * (`job.data._trace`), or null outside any context.
 *
 * @returns {{ requestId?: string, traceId: string, spanId: string, flags: string }|null}
 */
export function currentTraceCarrier() {
  const ctx = storage.getStore();
  if (!ctx?.traceId) return null;
  const carrier = { traceId: ctx.traceId, spanId: ctx.spanId, flags: ctx.flags ?? '01' };
  if (ctx.requestId) carrier.requestId = ctx.requestId;
  return carrier;
}

/**
 * Context for work continuing a carried trace (a queue job, a scheduled
 * tick). Untrusted carrier fields are validated; a missing or invalid
 * carrier starts a new trace.
 *
 * @param {Object|null|undefined} carrier - `job.data._trace`.
 * @param {Object} [extra] - e.g. `{ queue, jobId }` or `{ job }`.
 * @returns {Object}
 */
export function childTraceContext(carrier, extra = {}) {
  const traceId = typeof carrier?.traceId === 'string' && /^[0-9a-f]{32}$/.test(carrier.traceId)
    && carrier.traceId !== ZERO_TRACE_ID
    ? carrier.traceId
    : newTraceId();
  const parentSpanId = typeof carrier?.spanId === 'string' && /^[0-9a-f]{16}$/.test(carrier.spanId)
    ? carrier.spanId
    : null;
  const requestId = normalizeRequestId(carrier?.requestId);
  const flags = typeof carrier?.flags === 'string' && /^[0-9a-f]{2}$/.test(carrier.flags) ? carrier.flags : '01';
  return {
    ...(requestId ? { requestId } : {}),
    traceId,
    spanId: newSpanId(),
    parentSpanId,
    flags,
    ...extra,
  };
}

export default {
  normalizeRequestId,
  newTraceId,
  newSpanId,
  parseTraceparent,
  formatTraceparent,
  runWithTrace,
  getTraceContext,
  getTraceBindings,
  currentTraceCarrier,
  childTraceContext,
};
