/**
 * Resource consumption detection rule (roadmap 2.6, document 11 section 4).
 *
 * Sources: the access trace (request latency per tenant on query-heavy
 * surfaces) and a snapshot of the job queues taken on each detector run.
 *
 *   resource.consumption  (medium)  >= minSlowRequests requests slower than
 *                                   slowRequestMs for one tenant within
 *                                   windowMinutes on the query surfaces
 *                                   (`pathPrefixes`, under the API prefix)
 *                         (medium)  a queue with >= maxQueueWaiting waiting
 *                                   jobs (or >= maxQueueFailed failed jobs
 *                                   when that is set above 0)
 */

import { int, strings } from '../params.js';
import { MINUTE_MS, groupBy, slidingWindow, ref, lastRefs, topValues } from '../util.js';

function minus(date, ms) {
  return new Date(new Date(date).getTime() - ms);
}

function stripQuery(path) {
  return String(path ?? '').split('?')[0].slice(0, 200);
}

export const resourceConsumption = Object.freeze({
  id: 'resource.consumption',
  version: 1,
  title: 'Resource consumption above threshold',
  description: 'A tenant runs many slow queries in a short window, or a job queue backs up.',
  source: 'access_log',
  severity: 'medium',
  defaults: Object.freeze({
    enabled: true,
    windowMinutes: 15,
    slowRequestMs: 5000,
    minSlowRequests: 20,
    pathPrefixes: Object.freeze(['/analytics', '/dashboards', '/reports', '/external']),
    maxQueueWaiting: 1000,
    maxQueueFailed: 0,
  }),
  params: Object.freeze({
    windowMinutes: int(1, 1440),
    slowRequestMs: int(100, 600000),
    minSlowRequests: int(1, 1000000),
    pathPrefixes: strings({ maxItems: 20, maxLength: 120, pattern: '^/[A-Za-z0-9_./-]*$' }),
    maxQueueWaiting: int(0, 100000000),
    maxQueueFailed: int(0, 100000000),
  }),

  async evaluate({ from, to, config, sources, apiPrefix, finalSlice, queueStats }) {
    const windowMs = config.windowMinutes * MINUTE_MS;
    const detections = [];
    const slow = await sources.listAccessByPath({
      prefixes: config.pathPrefixes.map((prefix) => `${apiPrefix}${prefix}`),
      from: minus(from, windowMs),
      to,
      minLatencyMs: config.slowRequestMs,
    });
    for (const [tenantId, rows] of groupBy(slow, (row) => row.tenantId || null)) {
      const best = slidingWindow(rows, {
        windowMs,
        after: from,
        sums: { latencyMs: (row) => row.latencyMs ?? 0 },
        qualifies: (w) => w.count >= config.minSlowRequests,
      });
      if (!best) continue;
      detections.push({
        subject: { type: 'tenant', id: String(tenantId), display: String(tenantId) },
        dedupe: 'slow_queries',
        tenantId: String(tenantId),
        title: `Slow query load for tenant ${tenantId}`,
        summary: `${best.count} requests slower than ${config.slowRequestMs} ms within ${config.windowMinutes} minutes (${Math.round(best.sums.latencyMs / 1000)} s in total).`,
        windowStart: best.start,
        windowEnd: best.end,
        counts: { slowRequests: best.count, totalLatencyMs: Math.round(best.sums.latencyMs) },
        details: {
          kind: 'slow_queries',
          paths: topValues(best.events.map((row) => stripQuery(row.path))),
          threshold: { slowRequestMs: config.slowRequestMs, minSlowRequests: config.minSlowRequests, windowMinutes: config.windowMinutes },
        },
        refs: lastRefs(best.events.map((row) => ref('access_log', row._id, row.occurredAt, `${Math.round(row.latencyMs)} ms ${stripQuery(row.path)}`))),
      });
    }

    // Queue backlog is a point-in-time reading: once per run.
    if (finalSlice && typeof queueStats === 'function' && (config.maxQueueWaiting > 0 || config.maxQueueFailed > 0)) {
      const queues = await queueStats();
      for (const queue of queues ?? []) {
        const waiting = Number(queue.waiting ?? 0);
        const failed = Number(queue.failed ?? 0);
        const backlog = config.maxQueueWaiting > 0 && waiting >= config.maxQueueWaiting;
        const failing = config.maxQueueFailed > 0 && failed >= config.maxQueueFailed;
        if (!backlog && !failing) continue;
        detections.push({
          subject: { type: 'queue', id: String(queue.name), display: String(queue.name) },
          dedupe: 'backlog',
          title: `Queue ${queue.name} is backing up`,
          summary: `Queue ${queue.name} has ${waiting} waiting and ${failed} failed jobs.`,
          windowStart: to,
          windowEnd: to,
          counts: { waiting, active: Number(queue.active ?? 0), delayed: Number(queue.delayed ?? 0), failed },
          details: {
            kind: 'queue_backlog',
            transport: queue.transport ?? null,
            threshold: { maxQueueWaiting: config.maxQueueWaiting, maxQueueFailed: config.maxQueueFailed },
          },
          refs: [ref('queue', queue.name, to, `waiting ${waiting}, failed ${failed}`)],
        });
      }
    }
    return detections;
  },
});

export default [resourceConsumption];
