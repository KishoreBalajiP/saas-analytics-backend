/**
 * Support impersonation detection rule (roadmap 2.6, document 11 section 4).
 *
 * Source: the support audit event `impersonate` (module
 * `support.impersonation`; `SUPPORT_IMPERSONATION_STARTED` in the security
 * event catalogue). The acting admin is the actor, the impersonated user is
 * the resource.
 *
 *   support.impersonation  (medium)  impersonation started (one alert per
 *                                    admin per UTC day, later starts merge
 *                                    into it) when alertOnStart is on
 *                          (high)    more than maxPerAdminPerDay starts by
 *                                    one admin in a UTC day, or the
 *                                    impersonated user's email belongs to a
 *                                    platform administrator (admin-owned
 *                                    tenant)
 */

import { int, bool } from '../params.js';
import { groupBy, ref, lastRefs, utcDay, utcDayStart, distinctValues, topValues } from '../util.js';

export const IMPERSONATION_EVENT = Object.freeze({ module: 'support.impersonation', action: 'impersonate' });

export const impersonation = Object.freeze({
  id: 'support.impersonation',
  version: 1,
  title: 'Support impersonation',
  description: 'A support administrator impersonated a user; escalated when the daily count exceeds the cap or the user belongs to a platform administrator.',
  source: 'audit_log',
  severity: 'medium',
  defaults: Object.freeze({ enabled: true, alertOnStart: true, maxPerAdminPerDay: 5 }),
  params: Object.freeze({ alertOnStart: bool(), maxPerAdminPerDay: int(1, 1000) }),

  async evaluate({ from, to, config, sources }) {
    const rows = await sources.listAuditEvents({ pairs: [IMPERSONATION_EVENT], from, to });
    if (rows.length === 0) return [];

    // Impersonated users whose email is also a platform admin's email.
    const users = await sources.findUsersByIds(rows.map((row) => row.resourceId).filter(Boolean));
    const userEmail = new Map(users.map((user) => [String(user._id), user.email]));
    const adminEmails = new Set(
      (await sources.findAdminsByEmails(users.map((user) => user.email))).map((admin) => admin.email),
    );

    const detections = [];
    const byAdminDay = groupBy(rows, (row) => (row.actorId ? `${row.actorId}|${utcDay(row.occurredAt)}` : null));
    for (const [key, events] of byAdminDay) {
      const [adminId, day] = key.split('|');
      const last = events[events.length - 1];
      const dayTotal = await sources.countAuditEvents({
        pairs: [IMPERSONATION_EVENT],
        since: utcDayStart(last.occurredAt),
        before: new Date(new Date(last.occurredAt).getTime() + 1),
        extra: { actorId: adminId },
      });
      const adminOwned = events.filter((row) => adminEmails.has(userEmail.get(String(row.resourceId))));
      const overCap = dayTotal > config.maxPerAdminPerDay;
      if (!config.alertOnStart && !overCap && adminOwned.length === 0) continue;
      const severity = overCap || adminOwned.length > 0 ? 'high' : 'medium';
      const display = last.actorDisplay || null;
      const reasons = [];
      if (overCap) reasons.push(`${dayTotal} impersonations today (cap ${config.maxPerAdminPerDay})`);
      if (adminOwned.length > 0) reasons.push('impersonated user belongs to a platform administrator');
      detections.push({
        subject: { type: 'admin', id: adminId, display },
        dedupe: `day:${day}`,
        severity,
        tenantId: events.length === 1 ? last.tenantId ?? null : null,
        title: `Support impersonation by ${display ?? adminId}`,
        summary: `${display ?? adminId} started ${events.length} impersonation session(s) (${dayTotal} on ${day} UTC)`
          + (reasons.length ? `: ${reasons.join('; ')}.` : '.'),
        windowStart: events[0].occurredAt,
        windowEnd: last.occurredAt,
        counts: { started: events.length, dayTotal, adminOwnedTargets: adminOwned.length },
        details: {
          day,
          overCap,
          cap: config.maxPerAdminPerDay,
          targetUserIds: distinctValues(events.map((row) => row.resourceId), 20),
          tenants: distinctValues(events.map((row) => row.tenantId), 20),
          reasons: topValues(events.map((row) => row.reason)),
          adminOwnedTargetUserIds: distinctValues(adminOwned.map((row) => row.resourceId), 20),
        },
        refs: lastRefs(events.map((row) => ref('audit_log', row._id, row.occurredAt, `impersonated user ${row.resourceId ?? '-'} in tenant ${row.tenantId ?? '-'}`))),
      });
    }
    return detections;
  },
});

export default [impersonation];
