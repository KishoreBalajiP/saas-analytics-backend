/**
 * API-key misuse detection rules (roadmap 2.6, document 11 section 4).
 *
 * Source: per-minute request signals (`SecuritySignal`, written by
 * `middleware/securitySignals.middleware.js`): `api_key.request` (calls made
 * with a valid key: count, 4xx/5xx and the /24 or /48 client ranges) and
 * `api_key.auth_failed` (refused calls naming a key by its public prefix).
 * Signal rules evaluate buckets that are at least SIGNAL_LAG_MS old, so a
 * bucket is complete (every instance has flushed) before it is judged.
 *
 *   api_key.new_ip_range  (medium)  a key with an established baseline
 *                                   (>= minBaselineRequests in baselineDays)
 *                                   is used from a client range it never
 *                                   used in that baseline
 *   api_key.error_spike   (medium)  >= minRequests calls with an error rate
 *                                   >= minErrorRate within windowMinutes
 *   api_key.revoked_use   (medium)  >= minAttempts refused calls presenting
 *                                   a revoked or deleted key
 */

import { int, number } from '../params.js';
import {
  MINUTE_MS, DAY_MS, groupBy, slidingWindow, ref, lastRefs, distinctValues,
} from '../util.js';

/** Signal buckets are judged once they are this old (flush + settle). */
export const SIGNAL_LAG_MS = 2 * MINUTE_MS;

function after(date) {
  return new Date(new Date(date).getTime() + 1);
}

function minus(date, ms) {
  return new Date(new Date(date).getTime() - ms);
}

function keyDisplay(key, fallback) {
  if (!key) return fallback;
  return key.name ? `${key.name} (${key.prefix})` : key.prefix;
}

function signalRef(row, label) {
  return ref('security_signal', row._id, row.bucket, label);
}

export const apiKeyNewIpRange = Object.freeze({
  id: 'api_key.new_ip_range',
  version: 1,
  title: 'API key used from a new network range',
  description: 'An API key with an established usage baseline was used from a client network range it did not use before.',
  source: 'security_signal',
  severity: 'medium',
  lagMs: SIGNAL_LAG_MS,
  defaults: Object.freeze({ enabled: true, baselineDays: 7, minBaselineRequests: 20 }),
  params: Object.freeze({ baselineDays: int(1, 30), minBaselineRequests: int(1, 1000000) }),

  async evaluate({ from, to, config, signals, sources }) {
    const rows = await signals.findBuckets({ kind: 'api_key.request', from: after(from), to });
    if (rows.length === 0) return [];
    const groups = groupBy(rows, (row) => row.subject);
    const baseline = new Map(
      (await signals.totalsBySubject({
        kind: 'api_key.request',
        subjects: [...groups.keys()],
        from: minus(from, config.baselineDays * DAY_MS),
        to: after(from),
      })).map((row) => [row.subject, row]),
    );
    const keys = new Map((await sources.findApiKeysByIds([...groups.keys()])).map((key) => [String(key._id), key]));
    const detections = [];
    for (const [keyId, buckets] of groups) {
      const base = baseline.get(keyId);
      if (!base || base.count < config.minBaselineRequests) continue;
      const known = new Set(base.ipRanges);
      const fresh = buckets.filter((row) => (row.ipRanges ?? []).some((range) => !known.has(range)));
      if (fresh.length === 0) continue;
      const newRanges = distinctValues(fresh.flatMap((row) => row.ipRanges ?? []).filter((range) => !known.has(range)), 20);
      const key = keys.get(keyId);
      const display = keyDisplay(key, keyId);
      detections.push({
        subject: { type: 'api_key', id: keyId, display },
        tenantId: key?.tenantId ?? fresh[0].tenantId ?? null,
        title: `API key ${display} used from a new network range`,
        summary: `The API key ${display} was used from ${newRanges.join(', ')}, not seen in its last ${config.baselineDays} days of traffic.`,
        windowStart: fresh[0].bucket,
        windowEnd: fresh[fresh.length - 1].bucket,
        counts: { requests: fresh.reduce((sum, row) => sum + (row.count ?? 0), 0), newRanges: newRanges.length, baselineRequests: base.count },
        details: { newRanges, knownRanges: distinctValues(base.ipRanges, 10), baselineDays: config.baselineDays },
        refs: lastRefs(fresh.map((row) => signalRef(row, `${row.count} call(s) at ${new Date(row.bucket).toISOString()}`))),
      });
    }
    return detections;
  },
});

export const apiKeyErrorSpike = Object.freeze({
  id: 'api_key.error_spike',
  version: 1,
  title: 'API key error spike',
  description: 'Calls made with one API key fail at an unusual rate within a short window.',
  source: 'security_signal',
  severity: 'medium',
  lagMs: SIGNAL_LAG_MS,
  defaults: Object.freeze({ enabled: true, windowMinutes: 15, minRequests: 50, minErrorRate: 0.5 }),
  params: Object.freeze({ windowMinutes: int(1, 1440), minRequests: int(1, 10000000), minErrorRate: number(0.01, 1) }),

  async evaluate({ from, to, config, signals, sources }) {
    const windowMs = config.windowMinutes * MINUTE_MS;
    const rows = await signals.findBuckets({ kind: 'api_key.request', from: after(minus(from, windowMs)), to });
    const detections = [];
    const groups = groupBy(rows, (row) => row.subject);
    const hits = [];
    for (const [keyId, buckets] of groups) {
      const best = slidingWindow(buckets, {
        windowMs,
        after: from,
        time: (row) => row.bucket,
        weight: (row) => row.count ?? 0,
        sums: { errors: (row) => (row.clientErrors ?? 0) + (row.serverErrors ?? 0), serverErrors: (row) => row.serverErrors ?? 0 },
        qualifies: (w) => w.count >= config.minRequests && w.sums.errors / Math.max(1, w.count) >= config.minErrorRate,
      });
      if (best) hits.push([keyId, best]);
    }
    if (hits.length === 0) return detections;
    const keys = new Map((await sources.findApiKeysByIds(hits.map(([id]) => id))).map((key) => [String(key._id), key]));
    for (const [keyId, best] of hits) {
      const key = keys.get(keyId);
      const display = keyDisplay(key, keyId);
      const rate = best.sums.errors / Math.max(1, best.count);
      detections.push({
        subject: { type: 'api_key', id: keyId, display },
        tenantId: key?.tenantId ?? best.events[0].tenantId ?? null,
        title: `Error spike on API key ${display}`,
        summary: `${best.sums.errors} of ${best.count} calls with the API key ${display} failed (${Math.round(rate * 100)}%) within ${config.windowMinutes} minutes.`,
        windowStart: best.start,
        windowEnd: best.end,
        counts: { requests: best.count, errors: best.sums.errors, serverErrors: best.sums.serverErrors, errorRatePercent: Math.round(rate * 100) },
        details: {
          ipRanges: distinctValues(best.events.flatMap((row) => row.ipRanges ?? []), 10),
          threshold: { minRequests: config.minRequests, minErrorRate: config.minErrorRate, windowMinutes: config.windowMinutes },
        },
        refs: lastRefs(best.events.map((row) => signalRef(row, `${row.count} call(s), ${(row.clientErrors ?? 0) + (row.serverErrors ?? 0)} error(s)`))),
      });
    }
    return detections;
  },
});

export const apiKeyRevokedUse = Object.freeze({
  id: 'api_key.revoked_use',
  version: 1,
  title: 'Revoked API key still in use',
  description: 'Calls keep presenting an API key that was revoked or deleted.',
  source: 'security_signal',
  severity: 'medium',
  lagMs: SIGNAL_LAG_MS,
  defaults: Object.freeze({ enabled: true, minAttempts: 1 }),
  params: Object.freeze({ minAttempts: int(1, 1000000) }),

  async evaluate({ from, to, config, signals, sources }) {
    const rows = await signals.findBuckets({ kind: 'api_key.auth_failed', from: after(from), to });
    if (rows.length === 0) return [];
    const groups = groupBy(rows, (row) => row.subject);
    const keys = await sources.findApiKeysByPrefixes([...groups.keys()]);
    const detections = [];
    for (const key of keys) {
      if (key.status !== 'revoked' && !key.deletedAt) continue;
      // Only refusals after the key was retired count (a bucket covers one
      // minute, so it counts when it ends after the retirement).
      const retiredAt = key.revokedAt ?? key.deletedAt ?? null;
      const buckets = (groups.get(key.prefix) ?? []).filter(
        (row) => !retiredAt || new Date(row.bucket).getTime() + MINUTE_MS > new Date(retiredAt).getTime(),
      );
      const attempts = buckets.reduce((sum, row) => sum + (row.count ?? 0), 0);
      if (buckets.length === 0 || attempts < config.minAttempts) continue;
      const display = keyDisplay(key, key.prefix);
      detections.push({
        subject: { type: 'api_key', id: String(key._id), display },
        tenantId: key.tenantId ?? null,
        title: `Revoked API key ${display} is still being used`,
        summary: `${attempts} call(s) presented the ${key.deletedAt ? 'deleted' : 'revoked'} API key ${display}.`,
        windowStart: buckets[0].bucket,
        windowEnd: buckets[buckets.length - 1].bucket,
        counts: { attempts },
        details: {
          keyStatus: key.deletedAt ? 'deleted' : key.status,
          revokedAt: key.revokedAt ?? null,
          deletedAt: key.deletedAt ?? null,
          ipRanges: distinctValues(buckets.flatMap((row) => row.ipRanges ?? []), 10),
        },
        refs: lastRefs([
          ref('api_key', key._id, retiredAt, `key ${key.prefix} ${key.deletedAt ? 'deleted' : 'revoked'}`),
          ...buckets.map((row) => signalRef(row, `${row.count} refused call(s)`)),
        ]),
      });
    }
    return detections;
  },
});

export default [apiKeyNewIpRange, apiKeyErrorSpike, apiKeyRevokedUse];
