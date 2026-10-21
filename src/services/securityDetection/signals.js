/**
 * Request signal aggregation for the security detection rules (roadmap 2.6).
 *
 * WHY IT EXISTS
 *   Several rules need request-level facts that no store keeps today:
 *   which client ranges use an API key, how many calls fail, refused calls
 *   that present a revoked key, 429s per tenant, per-tenant request volume
 *   and webhook signature refusals per connector. Writing a row per request
 *   would be costly, so this module counts per (kind, subject, minute) in
 *   memory and flushes the counters in one unordered bulk upsert
 *   (`SecuritySignal`, `$inc`-merged across instances).
 *
 * GUARANTEES
 *   - Never throws on the request path; recording is O(1).
 *   - Bounded memory: at most `maxBufferedKeys` counters are held between
 *     flushes; new keys beyond that are dropped and counted (`dropped`).
 *   - No credentials: subjects are API key ids, API key PUBLIC prefixes,
 *     tenant / connector ids and client ranges (/24, /48), never raw keys,
 *     webhook tokens or full addresses.
 *   - Best effort: a failed flush is logged and the batch dropped; when the
 *     database is not connected nothing is written.
 */

import mongoose from 'mongoose';
import env from '../../config/env.js';
import logger from '../../utils/logger.js';
import securitySignalRepository from '../../repositories/securitySignal.repository.js';
import { SIGNAL_KINDS, MAX_SET_ENTRIES } from '../../models/SecuritySignal.js';
import { MINUTE_MS } from './util.js';

const KINDS = new Set(SIGNAL_KINDS);
const SUBJECT_RE = /^[A-Za-z0-9_.:/-]{1,200}$/;

/** key -> aggregated counter. */
let buffer = new Map();
let flushTimer = null;
let flushing = null;
const stats = { recorded: 0, dropped: 0, flushed: 0, failedFlushes: 0 };

function settings() {
  return env.securityDetection?.signals ?? {};
}

/** Minute bucket of an instant. */
export function bucketOf(at = new Date()) {
  const ms = new Date(at).getTime();
  return new Date(ms - (ms % MINUTE_MS));
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, Math.max(1000, Number(settings().flushIntervalMs) || 10000));
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Count one request signal.
 *
 * @param {Object} signal
 * @param {string} signal.kind - one of `SIGNAL_KINDS`.
 * @param {string} signal.subject - id / prefix / `tenant:<id>` / `ip:<range>`.
 * @param {string|null} [signal.tenantId]
 * @param {number} [signal.status] - HTTP status (4xx/5xx counted as errors).
 * @param {string|null} [signal.ipRange] - client range (never a full address).
 * @param {string|null} [signal.actor] - `<type>:<id>` of the caller.
 * @param {Date} [signal.at]
 * @returns {boolean} whether the signal was buffered.
 */
export function record({ kind, subject, tenantId = null, status = 0, ipRange = null, actor = null, at = new Date() } = {}) {
  try {
    if (settings().enabled === false) return false;
    if (!KINDS.has(kind) || typeof subject !== 'string' || !SUBJECT_RE.test(subject)) return false;
    const bucket = bucketOf(at);
    const key = `${kind}|${subject}|${bucket.getTime()}`;
    let entry = buffer.get(key);
    if (!entry) {
      if (buffer.size >= (Number(settings().maxBufferedKeys) || 10000)) {
        stats.dropped += 1;
        return false;
      }
      entry = {
        kind, subject, tenantId: tenantId ? String(tenantId) : null, bucket,
        count: 0, clientErrors: 0, serverErrors: 0, ipRanges: new Set(), actors: new Set(),
      };
      buffer.set(key, entry);
    }
    entry.count += 1;
    if (status >= 500) entry.serverErrors += 1;
    else if (status >= 400) entry.clientErrors += 1;
    if (ipRange && entry.ipRanges.size < MAX_SET_ENTRIES) entry.ipRanges.add(String(ipRange));
    if (actor && entry.actors.size < MAX_SET_ENTRIES) entry.actors.add(String(actor));
    if (!entry.tenantId && tenantId) entry.tenantId = String(tenantId);
    stats.recorded += 1;
    scheduleFlush();
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the buffered counters. Concurrent callers share one flush.
 *
 * @returns {Promise<number>} counters written.
 */
export async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing) return flushing;
  if (buffer.size === 0) return 0;
  const batch = [...buffer.values()].map((entry) => ({
    ...entry,
    ipRanges: [...entry.ipRanges],
    actors: [...entry.actors],
  }));
  buffer = new Map();
  if (mongoose.connection.readyState !== 1) {
    logger.debug({ count: batch.length }, '[security-signals] database not connected; batch dropped');
    return 0;
  }
  flushing = (async () => {
    try {
      await securitySignalRepository.upsertMany(batch, { retentionDays: settings().retentionDays ?? 35 });
      stats.flushed += batch.length;
      return batch.length;
    } catch (err) {
      stats.failedFlushes += 1;
      logger.warn({ err: { message: err?.message }, count: batch.length }, '[security-signals] flush failed; batch dropped');
      return 0;
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Counters for monitoring and tests. */
export function getSignalStats() {
  return { ...stats, buffered: buffer.size };
}

/** Test helper: drop buffered counters and reset statistics. */
export function resetSignals() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  buffer = new Map();
  stats.recorded = 0;
  stats.dropped = 0;
  stats.flushed = 0;
  stats.failedFlushes = 0;
}

export default { record, flush, bucketOf, getSignalStats, resetSignals };
