/**
 * Authentication detection rules (roadmap 2.6, document 11 section 4).
 *
 * Source: `LoginAttempt` (every sign-in attempt on both portals, with IP,
 * outcome and reason).
 *
 *   auth.credential_stuffing  (high)    >= minFailures failed sign-ins for
 *                                        >= minAccounts distinct accounts
 *                                        from one IP within windowMinutes
 *   auth.admin_failed_logins  (high)    >= minFailures failed sign-ins on one
 *                                        platform-admin account within
 *                                        windowMinutes (wrong password, wrong
 *                                        MFA code, lockout)
 *   auth.admin_new_ip         (medium)  a successful admin sign-in from an IP
 *                                        not seen for that admin in the last
 *                                        lookbackDays (admins without any
 *                                        earlier sign-in are skipped when
 *                                        requireHistory is on)
 */

import { int, bool } from '../params.js';
import {
  MINUTE_MS, DAY_MS, groupBy, slidingWindow, ipRange, ref, lastRefs, topValues, distinctValues,
} from '../util.js';

function before(date, ms) {
  return new Date(new Date(date).getTime() - ms);
}

export const credentialStuffing = Object.freeze({
  id: 'auth.credential_stuffing',
  version: 1,
  title: 'Credential stuffing from one IP',
  description: 'Many failed sign-ins for many different accounts from one IP address within a short window.',
  source: 'login_attempt',
  severity: 'high',
  defaults: Object.freeze({ enabled: true, windowMinutes: 15, minFailures: 20, minAccounts: 10 }),
  params: Object.freeze({ windowMinutes: int(1, 1440), minFailures: int(2, 100000), minAccounts: int(2, 100000) }),

  async evaluate({ from, to, config, sources }) {
    const windowMs = config.windowMinutes * MINUTE_MS;
    const failures = await sources.listLoginAttempts({ from: before(from, windowMs), to, success: false });
    const detections = [];
    for (const [ip, events] of groupBy(failures, (e) => e.ip || null)) {
      const best = slidingWindow(events, {
        windowMs,
        after: from,
        distinct: (e) => `${e.actorType}|${e.tenantId ?? '-'}|${e.email}`,
        qualifies: (w) => w.count >= config.minFailures && w.distinct >= config.minAccounts,
      });
      if (!best) continue;
      const adminAccounts = new Set(best.events.filter((e) => e.actorType === 'admin').map((e) => e.email)).size;
      detections.push({
        subject: { type: 'ip', id: ip, display: ip },
        title: `Credential stuffing from ${ip}`,
        summary: `${best.count} failed sign-ins for ${best.distinct} accounts from ${ip} within ${config.windowMinutes} minutes.`,
        windowStart: best.start,
        windowEnd: best.end,
        counts: { failures: best.count, accounts: best.distinct, adminAccounts },
        details: {
          ipRange: ipRange(ip),
          sampleAccounts: distinctValues(best.events.map((e) => e.email), 10),
          reasons: topValues(best.events.map((e) => e.reason)),
          portals: topValues(best.events.map((e) => e.actorType)),
          threshold: { minFailures: config.minFailures, minAccounts: config.minAccounts, windowMinutes: config.windowMinutes },
        },
        refs: lastRefs(best.events.map((e) => ref('login_attempt', e._id, e.occurredAt, `${e.actorType} ${e.email}: ${e.reason}`))),
      });
    }
    return detections;
  },
});

export const adminFailedLogins = Object.freeze({
  id: 'auth.admin_failed_logins',
  version: 1,
  title: 'Repeated failed sign-ins on an admin account',
  description: 'Repeated failed sign-ins (password, MFA code or lockout) on one platform-administrator account.',
  source: 'login_attempt',
  severity: 'high',
  defaults: Object.freeze({ enabled: true, windowMinutes: 15, minFailures: 5 }),
  params: Object.freeze({ windowMinutes: int(1, 1440), minFailures: int(2, 10000) }),

  async evaluate({ from, to, config, sources }) {
    const windowMs = config.windowMinutes * MINUTE_MS;
    const failures = await sources.listLoginAttempts({
      from: before(from, windowMs), to, success: false, actorType: 'admin',
    });
    const detections = [];
    // Unknown emails carry no actorId: they are not an admin account.
    for (const [actorId, events] of groupBy(failures, (e) => e.actorId || null)) {
      const best = slidingWindow(events, {
        windowMs,
        after: from,
        distinct: (e) => e.ip || null,
        qualifies: (w) => w.count >= config.minFailures,
      });
      if (!best) continue;
      const email = best.events[best.events.length - 1].email;
      const lockouts = best.events.filter((e) => e.reason === 'account_locked').length;
      detections.push({
        subject: { type: 'admin', id: String(actorId), display: email },
        title: `Repeated failed sign-ins for admin ${email}`,
        summary: `${best.count} failed sign-ins for the administrator ${email} from ${best.distinct} IP address(es) within ${config.windowMinutes} minutes.`,
        windowStart: best.start,
        windowEnd: best.end,
        counts: { failures: best.count, ips: best.distinct, lockouts },
        details: {
          ips: distinctValues(best.events.map((e) => e.ip), 10),
          reasons: topValues(best.events.map((e) => e.reason)),
          threshold: { minFailures: config.minFailures, windowMinutes: config.windowMinutes },
        },
        refs: lastRefs(best.events.map((e) => ref('login_attempt', e._id, e.occurredAt, `${e.ip || 'unknown ip'}: ${e.reason}`))),
      });
    }
    return detections;
  },
});

export const adminNewIp = Object.freeze({
  id: 'auth.admin_new_ip',
  version: 1,
  title: 'Admin sign-in from a first-seen IP',
  description: 'A platform administrator signed in from an IP address not seen for that administrator in the lookback period.',
  source: 'login_attempt',
  severity: 'medium',
  defaults: Object.freeze({ enabled: true, lookbackDays: 30, requireHistory: true }),
  params: Object.freeze({ lookbackDays: int(1, 365), requireHistory: bool() }),

  async evaluate({ from, to, config, sources }) {
    const lookbackMs = config.lookbackDays * DAY_MS;
    const successes = await sources.listLoginAttempts({ from, to, success: true, actorType: 'admin' });
    const detections = [];
    const seen = new Set();
    for (const attempt of successes) {
      if (!attempt.actorId || !attempt.ip) continue;
      const pair = `${attempt.actorId}|${attempt.ip}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const since = before(attempt.occurredAt, lookbackMs);
      const known = await sources.findPriorAdminLogin({
        actorId: attempt.actorId, ip: attempt.ip, since, before: attempt.occurredAt,
      });
      if (known) continue;
      const previous = await sources.findPriorAdminLogin({ actorId: attempt.actorId, since, before: attempt.occurredAt });
      if (!previous && config.requireHistory) continue;
      detections.push({
        subject: { type: 'admin', id: String(attempt.actorId), display: attempt.email },
        dedupe: `ip:${attempt.ip}`,
        title: `Admin ${attempt.email} signed in from a new IP`,
        summary: `The administrator ${attempt.email} signed in from ${attempt.ip}, not seen for this account in the last ${config.lookbackDays} days.`,
        windowStart: attempt.occurredAt,
        windowEnd: attempt.occurredAt,
        counts: { logins: 1 },
        details: {
          ip: attempt.ip,
          ipRange: ipRange(attempt.ip),
          previousIp: previous?.ip ?? null,
          previousLoginAt: previous?.occurredAt ?? null,
          sameRangeAsPrevious: previous ? ipRange(previous.ip) === ipRange(attempt.ip) : false,
          lookbackDays: config.lookbackDays,
        },
        refs: [ref('login_attempt', attempt._id, attempt.occurredAt, `sign-in from ${attempt.ip}`)],
      });
    }
    return detections;
  },
});

export default [credentialStuffing, adminFailedLogins, adminNewIp];
