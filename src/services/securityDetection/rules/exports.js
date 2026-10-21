/**
 * Export detection rule (roadmap 2.6, document 11 section 4).
 *
 * Sources: audit / access-log export requests (`AuditExport`, requested by
 * platform admins) and successful data export requests in the access trace
 * (`POST <apiPrefix>/analytics/export` by default, any caller), plus role
 * grants (`rbac.role.granted`, roadmap 2.5) for the new-grant check.
 *
 *   export.unusual_volume  (medium)  one caller's exports within
 *                                    windowMinutes reach max(minExports,
 *                                    baselineMultiplier x their average per
 *                                    window over baselineDays)
 *                          (medium)  an export by a caller who was granted a
 *                                    role within newGrantDays before it
 */

import { int, number, bool, strings } from '../params.js';
import {
  MINUTE_MS, DAY_MS, groupBy, slidingWindow, ref, lastRefs, topValues, baselinePerWindow,
} from '../util.js';

export const ROLE_GRANTED_EVENT = Object.freeze({ module: 'iam.roles', action: 'rbac.role.granted' });

function minus(date, ms) {
  return new Date(new Date(date).getTime() - ms);
}

function stripQuery(path) {
  return String(path ?? '').split('?')[0].slice(0, 200);
}

/** Every export in (from, to] as `{ actorType, actorId, tenantId, at, kind, ref }`. */
async function loadExports({ from, to, config, sources, apiPrefix }) {
  const prefixes = config.pathPrefixes.map((prefix) => `${apiPrefix}${prefix}`);
  const [auditExports, dataExports] = await Promise.all([
    sources.listAuditExports({ from, to }),
    sources.listAccessByPath({ prefixes, from, to, method: 'POST', maxStatusCode: 399 }),
  ]);
  const events = [
    ...auditExports.filter((row) => row.requestedBy).map((row) => ({
      actorType: 'admin',
      actorId: String(row.requestedBy),
      tenantId: row.tenantId ?? null,
      at: row.createdAt,
      kind: `${row.kind}-log export`,
      ref: ref('audit_export', row.exportId ?? row._id, row.createdAt, `${row.kind} export (${row.format})`),
    })),
    ...dataExports.filter((row) => row.actorId).map((row) => ({
      actorType: row.actorType ?? 'user',
      actorId: String(row.actorId),
      tenantId: row.tenantId ?? null,
      at: row.occurredAt,
      kind: stripQuery(row.path),
      ref: ref('access_log', row._id, row.occurredAt, `${row.method} ${stripQuery(row.path)}`),
    })),
  ];
  return events.sort((a, b) => new Date(a.at) - new Date(b.at));
}

async function countBaseline({ actorType, actorId, since, before, config, sources, apiPrefix }) {
  const prefixes = config.pathPrefixes.map((prefix) => `${apiPrefix}${prefix}`);
  const [audit, data] = await Promise.all([
    actorType === 'admin' ? sources.countAuditExportsFor({ requestedBy: actorId, since, before }) : 0,
    sources.countAccessForActor({ actorId, prefixes, since, before, method: 'POST', maxStatusCode: 399 }),
  ]);
  return audit + data;
}

export const unusualExports = Object.freeze({
  id: 'export.unusual_volume',
  version: 1,
  title: 'Unusual export activity',
  description: 'A caller exports far more than their usual volume, or exports shortly after being granted a role.',
  source: 'audit_export',
  severity: 'medium',
  defaults: Object.freeze({
    enabled: true,
    windowMinutes: 60,
    minExports: 10,
    baselineDays: 14,
    baselineMultiplier: 3,
    alertOnNewGrant: true,
    newGrantDays: 7,
    pathPrefixes: Object.freeze(['/analytics/export']),
  }),
  params: Object.freeze({
    windowMinutes: int(1, 1440),
    minExports: int(1, 1000000),
    baselineDays: int(1, 90),
    baselineMultiplier: number(1, 1000),
    alertOnNewGrant: bool(),
    newGrantDays: int(1, 90),
    pathPrefixes: strings({ maxItems: 10, maxLength: 120, pattern: '^/[A-Za-z0-9_./-]*$' }),
  }),

  async evaluate({ from, to, config, sources, apiPrefix }) {
    const windowMs = config.windowMinutes * MINUTE_MS;
    const events = await loadExports({ from: minus(from, windowMs), to, config, sources, apiPrefix });
    const detections = [];
    const groups = groupBy(events, (e) => `${e.actorType}:${e.actorId}`);
    for (const [key, list] of groups) {
      const { actorType, actorId } = list[0];
      const fresh = list.filter((e) => new Date(e.at) > new Date(from));
      if (fresh.length === 0) continue;
      const display = `${actorType} ${actorId}`;
      const tenantId = fresh[fresh.length - 1].tenantId ?? null;

      // Volume above the caller's own baseline.
      const quick = slidingWindow(list, {
        windowMs, after: from, time: (e) => e.at, qualifies: (w) => w.count >= config.minExports,
      });
      if (quick) {
        const baselineMs = config.baselineDays * DAY_MS;
        const total = await countBaseline({
          actorType, actorId, since: minus(from, windowMs + baselineMs), before: minus(from, windowMs), config, sources, apiPrefix,
        });
        const average = baselinePerWindow(total, { baselineMs, windowMs });
        const threshold = Math.max(config.minExports, Math.ceil(config.baselineMultiplier * average));
        const best = slidingWindow(list, {
          windowMs, after: from, time: (e) => e.at, qualifies: (w) => w.count >= threshold,
        });
        if (best) {
          detections.push({
            subject: { type: actorType, id: actorId, display },
            dedupe: 'volume',
            tenantId,
            title: `Unusual export volume by ${display}`,
            summary: `${best.count} exports within ${config.windowMinutes} minutes (threshold ${threshold}, usual ${average.toFixed(2)} per window).`,
            windowStart: best.start,
            windowEnd: best.end,
            counts: { exports: best.count, threshold, baselinePerWindow: Number(average.toFixed(2)) },
            details: { kind: 'volume', exportTypes: topValues(best.events.map((e) => e.kind)) },
            refs: lastRefs(best.events.map((e) => e.ref)),
          });
        }
      }

      // Export shortly after a role grant.
      if (config.alertOnNewGrant) {
        const first = fresh[0];
        const grant = await sources.findLatestAuditEvent({
          pairs: [ROLE_GRANTED_EVENT],
          since: minus(first.at, config.newGrantDays * DAY_MS),
          before: first.at,
          extra: {
            $and: [{
              $or: [{ 'metadata.granteeId': actorId }, { 'after.granteeId': actorId }, { resourceId: actorId }],
            }],
          },
        });
        if (grant) {
          const roleName = grant.metadata?.roleName ?? grant.after?.roleName ?? null;
          detections.push({
            subject: { type: actorType, id: actorId, display },
            dedupe: 'new_grant',
            tenantId,
            title: `Export by ${display} shortly after a role grant`,
            summary: `${display} exported data ${fresh.length} time(s) within ${config.newGrantDays} days of being granted ${roleName ? `the role "${roleName}"` : 'a role'}.`,
            windowStart: grant.occurredAt,
            windowEnd: fresh[fresh.length - 1].at,
            counts: { exports: fresh.length },
            details: { kind: 'new_grant', roleName, grantedAt: grant.occurredAt, exportTypes: topValues(fresh.map((e) => e.kind)) },
            refs: lastRefs([ref('audit_log', grant._id, grant.occurredAt, `role granted${roleName ? `: ${roleName}` : ''}`), ...fresh.map((e) => e.ref)]),
          });
        }
      }
    }
    return detections;
  },
});

export default [unusualExports];
