/**
 * Connector authentication detection rule (roadmap 2.6, document 11
 * section 4).
 *
 * Sources: webhook signature refusals per connector and refusals for
 * unknown webhook tokens per client range (request signals
 * `connector.auth_failed` / `webhook.unknown_token`), and failed sync runs
 * whose error code means the source refused or could not be reached with
 * the stored credentials (`syncErrorCodes`; pull connector errors are
 * sanitised, so `CONNECTOR_SOURCE_UNAVAILABLE` covers authentication
 * failures of database connectors).
 *
 *   connector.auth_failures  (low)     >= minFailures authentication
 *                                      failures for one connector within
 *                                      windowMinutes
 *                            (medium)  >= minUnknownTokenFailures refused
 *                                      deliveries to unknown webhook tokens
 *                                      from one client range (token probing)
 */

import { int, strings } from '../params.js';
import { MINUTE_MS, groupBy, slidingWindow, ref, lastRefs, topValues } from '../util.js';
import { SIGNAL_LAG_MS } from './apiKeys.js';

function minus(date, ms) {
  return new Date(new Date(date).getTime() - ms);
}

function after(date) {
  return new Date(new Date(date).getTime() + 1);
}

export const connectorAuthFailures = Object.freeze({
  id: 'connector.auth_failures',
  version: 1,
  title: 'Repeated connector authentication failures',
  description: 'A connector keeps failing authentication (webhook signatures or source credentials), or a client probes unknown webhook tokens.',
  source: 'security_signal',
  severity: 'low',
  lagMs: SIGNAL_LAG_MS,
  defaults: Object.freeze({
    enabled: true,
    windowMinutes: 60,
    minFailures: 5,
    minUnknownTokenFailures: 20,
    syncErrorCodes: Object.freeze(['CONNECTOR_SOURCE_UNAVAILABLE', 'CONNECTOR_AUTH_FAILED']),
  }),
  params: Object.freeze({
    windowMinutes: int(1, 1440),
    minFailures: int(1, 1000000),
    minUnknownTokenFailures: int(1, 1000000),
    syncErrorCodes: strings({ maxItems: 20, maxLength: 64, pattern: '^[A-Z0-9_]+$' }),
  }),

  async evaluate({ from, to, config, signals, sources }) {
    const windowMs = config.windowMinutes * MINUTE_MS;
    const start = minus(from, windowMs);
    const [signalRows, syncRuns, probes] = await Promise.all([
      signals.findBuckets({ kind: 'connector.auth_failed', from: after(start), to }),
      config.syncErrorCodes.length
        ? sources.listFailedSyncRuns({ from: start, to, codes: config.syncErrorCodes })
        : [],
      signals.findBuckets({ kind: 'webhook.unknown_token', from: after(start), to }),
    ]);
    const events = [
      ...signalRows.map((row) => ({
        connectorId: row.subject,
        tenantId: row.tenantId ?? null,
        at: row.bucket,
        weight: row.count ?? 0,
        kind: 'webhook_signature',
        ref: ref('security_signal', row._id, row.bucket, `${row.count} refused webhook delivery(ies)`),
      })),
      ...syncRuns.map((run) => ({
        connectorId: String(run.connectorId),
        tenantId: run.tenantId ?? null,
        at: run.finishedAt,
        weight: 1,
        kind: run.error?.code ?? 'sync_failed',
        ref: ref('sync_run', run._id, run.finishedAt, `sync failed: ${run.error?.code ?? 'unknown'}`),
      })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));

    const detections = [];
    for (const [connectorId, list] of groupBy(events, (e) => e.connectorId)) {
      const best = slidingWindow(list, {
        windowMs, after: from, time: (e) => e.at, weight: (e) => e.weight, qualifies: (w) => w.count >= config.minFailures,
      });
      if (!best) continue;
      const tenantId = list.find((e) => e.tenantId)?.tenantId ?? null;
      detections.push({
        subject: { type: 'connector', id: connectorId, display: connectorId },
        dedupe: 'auth',
        tenantId,
        title: `Repeated authentication failures for connector ${connectorId}`,
        summary: `${best.count} authentication failures for one connector within ${config.windowMinutes} minutes.`,
        windowStart: best.start,
        windowEnd: best.end,
        counts: { failures: best.count },
        details: { kinds: topValues(best.events.map((e) => e.kind)), threshold: { minFailures: config.minFailures, windowMinutes: config.windowMinutes } },
        refs: lastRefs(best.events.map((e) => e.ref)),
      });
    }

    for (const [range, buckets] of groupBy(probes, (row) => row.subject)) {
      const best = slidingWindow(buckets, {
        windowMs,
        after: from,
        time: (row) => row.bucket,
        weight: (row) => row.count ?? 0,
        qualifies: (w) => w.count >= config.minUnknownTokenFailures,
      });
      if (!best) continue;
      const id = String(range).replace(/^ip:/, '');
      detections.push({
        subject: { type: 'ip_range', id, display: id },
        dedupe: 'webhook_token_probing',
        severity: 'medium',
        title: `Webhook token probing from ${id}`,
        summary: `${best.count} deliveries to unknown webhook tokens from ${id} within ${config.windowMinutes} minutes.`,
        windowStart: best.start,
        windowEnd: best.end,
        counts: { refused: best.count },
        details: { kind: 'webhook_token_probing', threshold: { minUnknownTokenFailures: config.minUnknownTokenFailures, windowMinutes: config.windowMinutes } },
        refs: lastRefs(best.events.map((row) => ref('security_signal', row._id, row.bucket, `${row.count} unknown-token delivery(ies)`))),
      });
    }
    return detections;
  },
});

export default [connectorAuthFailures];
