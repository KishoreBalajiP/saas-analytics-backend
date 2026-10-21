/**
 * Request-volume and authorization detection rules (roadmap 2.6,
 * document 11 section 4).
 *
 * Sources: per-minute request signals (`rate_limit.hit`, `tenant.request`),
 * the access trace (403 responses of authenticated callers) and the
 * `request.denied` security event (cross-tenant / out-of-scope refusals,
 * roadmap 2.5).
 *
 *   traffic.rate_limit_hits  (medium)  429s for one tenant or client range
 *                                      within windowMinutes reach
 *                                      max(minHits, baselineMultiplier x the
 *                                      subject's average per window over
 *                                      baselineDays)
 *   traffic.request_volume   (medium)  one tenant's requests within
 *                                      windowMinutes reach max(minRequests,
 *                                      baselineMultiplier x its average)
 *   authz.repeated_denials   (medium)  >= minDenials 403 responses for one
 *                                      caller within windowMinutes
 *                            (high)    >= minCrossTenantDenials cross-tenant
 *                                      or out-of-scope refusals for one
 *                                      caller within windowMinutes
 */

import { int, number } from '../params.js';
import {
  MINUTE_MS, DAY_MS, groupBy, slidingWindow, ref, lastRefs, topValues, distinctValues, baselinePerWindow,
} from '../util.js';
import { SIGNAL_LAG_MS } from './apiKeys.js';

export const DENIED_EVENT = Object.freeze({ module: 'security.access', action: 'request.denied' });
export const CROSS_TENANT_REASONS = Object.freeze(['cross_tenant', 'tenant_scope']);

function after(date) {
  return new Date(new Date(date).getTime() + 1);
}

function minus(date, ms) {
  return new Date(new Date(date).getTime() - ms);
}

/** `tenant:<id>` / `ip:<range>` signal subjects as alert subjects. */
function signalSubject(subject) {
  const [type, ...rest] = String(subject).split(':');
  const id = rest.join(':');
  if (type === 'tenant') return { subject: { type: 'tenant', id, display: id }, tenantId: id };
  if (type === 'ip') return { subject: { type: 'ip_range', id, display: id }, tenantId: null };
  return { subject: { type: 'other', id: String(subject), display: String(subject) }, tenantId: null };
}

/**
 * Shared evaluation of "volume above baseline" over signal buckets.
 *
 * @returns {Promise<Array<{ subject: string, best: Object, threshold: number, baselineAverage: number }>>}
 */
async function volumeAboveBaseline({ kind, from, to, config, signals, minimum }) {
  const windowMs = config.windowMinutes * MINUTE_MS;
  const rows = await signals.findBuckets({ kind, from: after(minus(from, windowMs)), to });
  if (rows.length === 0) return [];
  const groups = groupBy(rows, (row) => row.subject);
  // Cheap pre-filter with the absolute minimum before reading baselines.
  const candidates = [];
  for (const [subject, buckets] of groups) {
    const best = slidingWindow(buckets, {
      windowMs, after: from, time: (row) => row.bucket, weight: (row) => row.count ?? 0, qualifies: (w) => w.count >= minimum,
    });
    if (best) candidates.push(subject);
  }
  if (candidates.length === 0) return [];
  const baselineMs = config.baselineDays * DAY_MS;
  const baselineFrom = minus(from, windowMs + baselineMs);
  const baseline = new Map(
    (await signals.totalsBySubject({ kind, subjects: candidates, from: baselineFrom, to: after(minus(from, windowMs)) }))
      .map((row) => [row.subject, row]),
  );
  const results = [];
  for (const subject of candidates) {
    const baselineAverage = baselinePerWindow(baseline.get(subject)?.count ?? 0, { baselineMs, windowMs });
    const threshold = Math.max(minimum, Math.ceil(config.baselineMultiplier * baselineAverage));
    const best = slidingWindow(groups.get(subject), {
      windowMs, after: from, time: (row) => row.bucket, weight: (row) => row.count ?? 0, qualifies: (w) => w.count >= threshold,
    });
    if (best) results.push({ subject, best, threshold, baselineAverage });
  }
  return results;
}

export const rateLimitHits = Object.freeze({
  id: 'traffic.rate_limit_hits',
  version: 1,
  title: 'Rate-limit hits above baseline',
  description: 'One tenant or client network range keeps hitting rate limits well above its usual level.',
  source: 'security_signal',
  severity: 'medium',
  lagMs: SIGNAL_LAG_MS,
  defaults: Object.freeze({ enabled: true, windowMinutes: 15, minHits: 50, baselineDays: 7, baselineMultiplier: 5 }),
  params: Object.freeze({
    windowMinutes: int(1, 1440), minHits: int(1, 10000000), baselineDays: int(1, 30), baselineMultiplier: number(1, 1000),
  }),

  async evaluate({ from, to, config, signals }) {
    const found = await volumeAboveBaseline({ kind: 'rate_limit.hit', from, to, config, signals, minimum: config.minHits });
    return found.map(({ subject, best, threshold, baselineAverage }) => {
      const { subject: alertSubject, tenantId } = signalSubject(subject);
      return {
        subject: alertSubject,
        tenantId,
        title: `Rate-limit hits for ${alertSubject.type === 'tenant' ? 'tenant' : 'network range'} ${alertSubject.id}`,
        summary: `${best.count} rate-limited requests within ${config.windowMinutes} minutes (threshold ${threshold}, usual ${baselineAverage.toFixed(1)} per window).`,
        windowStart: best.start,
        windowEnd: best.end,
        counts: { hits: best.count, threshold, baselinePerWindow: Number(baselineAverage.toFixed(2)) },
        details: {
          ipRanges: distinctValues(best.events.flatMap((row) => row.ipRanges ?? []), 10),
          threshold: { minHits: config.minHits, baselineMultiplier: config.baselineMultiplier, windowMinutes: config.windowMinutes },
        },
        refs: lastRefs(best.events.map((row) => ref('security_signal', row._id, row.bucket, `${row.count} rate-limited request(s)`))),
      };
    });
  },
});

export const requestVolume = Object.freeze({
  id: 'traffic.request_volume',
  version: 1,
  title: 'Abnormal request volume',
  description: 'A tenant sends far more requests than its usual level within a short window.',
  source: 'security_signal',
  severity: 'medium',
  lagMs: SIGNAL_LAG_MS,
  defaults: Object.freeze({ enabled: true, windowMinutes: 15, minRequests: 5000, baselineDays: 7, baselineMultiplier: 5 }),
  params: Object.freeze({
    windowMinutes: int(1, 1440), minRequests: int(1, 100000000), baselineDays: int(1, 30), baselineMultiplier: number(1, 1000),
  }),

  async evaluate({ from, to, config, signals }) {
    const found = await volumeAboveBaseline({ kind: 'tenant.request', from, to, config, signals, minimum: config.minRequests });
    return found.map(({ subject, best, threshold, baselineAverage }) => ({
      subject: { type: 'tenant', id: subject, display: subject },
      tenantId: subject,
      title: `Abnormal request volume for tenant ${subject}`,
      summary: `${best.count} requests within ${config.windowMinutes} minutes (threshold ${threshold}, usual ${baselineAverage.toFixed(1)} per window).`,
      windowStart: best.start,
      windowEnd: best.end,
      counts: {
        requests: best.count,
        errors: best.events.reduce((sum, row) => sum + (row.clientErrors ?? 0) + (row.serverErrors ?? 0), 0),
        threshold,
        baselinePerWindow: Number(baselineAverage.toFixed(2)),
      },
      details: {
        ipRanges: distinctValues(best.events.flatMap((row) => row.ipRanges ?? []), 10),
        threshold: { minRequests: config.minRequests, baselineMultiplier: config.baselineMultiplier, windowMinutes: config.windowMinutes },
      },
      refs: lastRefs(best.events.map((row) => ref('security_signal', row._id, row.bucket, `${row.count} request(s)`))),
    }));
  },
});

function stripQuery(path) {
  return String(path ?? '').split('?')[0].slice(0, 200);
}

export const authorizationFailures = Object.freeze({
  id: 'authz.repeated_denials',
  version: 1,
  title: 'Repeated authorization failures',
  description: 'One caller is refused (403) repeatedly, especially when it reaches for another tenant\'s data.',
  source: 'access_log',
  severity: 'high',
  defaults: Object.freeze({ enabled: true, windowMinutes: 10, minDenials: 20, minCrossTenantDenials: 3 }),
  params: Object.freeze({ windowMinutes: int(1, 1440), minDenials: int(1, 1000000), minCrossTenantDenials: int(1, 1000000) }),

  async evaluate({ from, to, config, sources }) {
    const windowMs = config.windowMinutes * MINUTE_MS;
    const start = minus(from, windowMs);
    const [denials, crossTenant] = await Promise.all([
      sources.listAccessByStatus({ statusCode: 403, from: start, to }),
      sources.listAuditEvents({
        pairs: [DENIED_EVENT], from: start, to, extra: { reason: { $in: [...CROSS_TENANT_REASONS] } },
      }),
    ]);
    const actorKey = (row) => (row.actorId ? `${row.actorType ?? 'user'}:${row.actorId}` : null);
    const denialGroups = groupBy(denials, actorKey);
    const crossGroups = groupBy(crossTenant, actorKey);
    const detections = [];
    for (const key of new Set([...denialGroups.keys(), ...crossGroups.keys()])) {
      const cross = slidingWindow(crossGroups.get(key) ?? [], {
        windowMs, after: from, qualifies: (w) => w.count >= config.minCrossTenantDenials,
      });
      const total = slidingWindow(denialGroups.get(key) ?? [], {
        windowMs, after: from, qualifies: (w) => w.count >= config.minDenials,
      });
      if (!cross && !total) continue;
      const [actorType, ...rest] = key.split(':');
      const actorId = rest.join(':');
      const sample = (total ?? cross).events;
      const tenantId = denialGroups.get(key)?.[0]?.tenantId ?? null;
      const requestedTenants = cross
        ? distinctValues(cross.events.map((row) => row.metadata?.requestedTenantId ?? row.tenantId), 10)
        : [];
      detections.push({
        subject: { type: actorType, id: actorId, display: crossGroups.get(key)?.[0]?.actorDisplay || null },
        severity: cross ? 'high' : 'medium',
        tenantId,
        title: cross ? `Cross-tenant access attempts by ${actorType} ${actorId}` : `Repeated authorization failures for ${actorType} ${actorId}`,
        summary: cross
          ? `${cross.count} cross-tenant or out-of-scope requests refused within ${config.windowMinutes} minutes${total ? ` (${total.count} refusals in total)` : ''}.`
          : `${total.count} requests refused with 403 within ${config.windowMinutes} minutes.`,
        windowStart: (cross ?? total).start,
        windowEnd: (cross ?? total).end,
        counts: { denials: total?.count ?? 0, crossTenantDenials: cross?.count ?? 0 },
        details: {
          paths: topValues(sample.map((row) => stripQuery(row.path ?? row.metadata?.route ?? row.resourceId))),
          requestedTenants,
          threshold: { minDenials: config.minDenials, minCrossTenantDenials: config.minCrossTenantDenials, windowMinutes: config.windowMinutes },
        },
        refs: lastRefs([
          ...(cross ? cross.events.map((row) => ref('audit_log', row._id, row.occurredAt, `refused: ${row.reason ?? 'cross_tenant'}`)) : []),
          ...(total ? total.events.map((row) => ref('access_log', row._id, row.occurredAt, `403 ${row.method ?? ''} ${stripQuery(row.path)}`)) : []),
        ]),
      });
    }
    return detections;
  },
});

export default [rateLimitHits, requestVolume, authorizationFailures];
