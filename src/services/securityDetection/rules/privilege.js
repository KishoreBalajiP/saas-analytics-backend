/**
 * Privilege and MFA detection rules (roadmap 2.6, document 11 section 4).
 *
 * Source: security events in the audit trail (roadmap 2.5 catalogue,
 * `constants/securityEvents.js`): `admin.privilege.changed`,
 * `admin.privilege.change_denied`, `rbac.role.granted` / `rbac.role.revoked`,
 * `auth.mfa.disabled`, `auth.mfa.enrolled`, `auth.mfa.reset_by_admin`
 * (adminauth: one administrator clears another's MFA).
 *
 *   iam.privilege_change  (high)    any grant of super-administrator rights
 *                                   (admin type changed to `super`, or a
 *                                   role named in superRoleNames granted to
 *                                   an admin); any refused privilege change,
 *                                   self-targeted attempts called out.
 *                         (medium)  optional: any admin privilege change
 *                                   outside the configured change window
 *   auth.admin_mfa_change (high)    MFA disabled for an admin (by the
 *                                   admin, or reset by another admin), or
 *                                   an admin enrolling MFA again after an
 *                                   earlier enrolment/disable within the
 *                                   lookback. v2 added the admin reset.
 */

import { int, bool, strings, ints, timeZone } from '../params.js';
import { DAY_MS, ref, eventMetadata } from '../util.js';

export const PRIVILEGE_EVENTS = Object.freeze({
  CHANGED: Object.freeze({ module: 'iam.admins', action: 'admin.privilege.changed' }),
  DENIED: Object.freeze({ module: 'iam.admins', action: 'admin.privilege.change_denied' }),
  ROLE_GRANTED: Object.freeze({ module: 'iam.roles', action: 'rbac.role.granted' }),
  ROLE_REVOKED: Object.freeze({ module: 'iam.roles', action: 'rbac.role.revoked' }),
});

export const MFA_EVENTS = Object.freeze({
  DISABLED: Object.freeze({ module: 'iam.auth', action: 'auth.mfa.disabled' }),
  ENROLLED: Object.freeze({ module: 'iam.auth', action: 'auth.mfa.enrolled' }),
  // adminauth: MFA cleared by another administrator (target in metadata).
  RESET_BY_ADMIN: Object.freeze({ module: 'iam.admins', action: 'auth.mfa.reset_by_admin' }),
});

/**
 * Earlier events that make a new enrolment a re-enrolment. An admin reset
 * is not one of them: it forces the next enrolment, which is expected.
 */
const REENROL_PRIOR_EVENTS = Object.freeze([MFA_EVENTS.DISABLED, MFA_EVENTS.ENROLLED]);

const WEEKDAYS = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });

/** Local weekday (0 = Sunday) and hour of an instant in a time zone. */
function localTime(at, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'short', hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const weekday = WEEKDAYS[parts.find((p) => p.type === 'weekday')?.value] ?? 0;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  return { weekday, hour };
}

/** Whether `at` falls inside the configured change window. */
export function insideChangeWindow(at, config) {
  const { weekday, hour } = localTime(at, config.changeWindowTimeZone);
  if (!config.changeWindowDays.includes(weekday)) return false;
  return hour >= config.changeWindowStartHour && hour < config.changeWindowEndHour;
}

function actorOf(row) {
  return { type: row.actorType ?? 'system', id: row.actorId ?? null, display: row.actorDisplay || null };
}

/** Classify one privilege event; null when the rule ignores it. */
function classify(row, config) {
  const meta = eventMetadata(row);
  const superRoles = new Set(config.superRoleNames.map((name) => name.toLowerCase()));
  if (row.action === PRIVILEGE_EVENTS.DENIED.action) {
    const reason = meta.reason ?? row.reason ?? null;
    const self = reason === 'self_change';
    return {
      kind: self ? 'self_change_attempt' : 'denied_change',
      severity: 'high',
      subject: { type: 'admin', id: row.actorId ?? 'unknown', display: row.actorDisplay || null },
      title: self ? 'Admin tried to change their own privileges' : 'Refused administrator privilege change',
      summary: self
        ? `An administrator tried to change their own roles, type or scope (refused).`
        : `An administrator privilege change was refused (${reason ?? 'not allowed'}).`,
      target: meta.targetId ?? row.resourceId ?? null,
      reason,
    };
  }
  const adminGrant = row.action === PRIVILEGE_EVENTS.ROLE_GRANTED.action
    && (meta.granteeType ?? row.resourceType) === 'admin';
  const adminRevoke = row.action === PRIVILEGE_EVENTS.ROLE_REVOKED.action
    && (meta.granteeType ?? row.resourceType) === 'admin';
  const typeChange = row.action === PRIVILEGE_EVENTS.CHANGED.action;
  const target = meta.adminId ?? meta.granteeId ?? row.resourceId ?? null;
  const superGrant = (typeChange && meta.changes?.adminType?.to === 'super')
    || (adminGrant && superRoles.has(String(meta.roleName ?? '').toLowerCase()));
  if (superGrant) {
    return {
      kind: 'super_grant',
      severity: 'high',
      subject: { type: 'admin', id: target ?? 'unknown', display: meta.email ?? null },
      title: 'Super-administrator rights granted',
      summary: typeChange
        ? `An administrator account was given the super administrator type (${meta.operation ?? 'update'}).`
        : `The role "${meta.roleName}" was granted to an administrator.`,
      target,
      reason: null,
    };
  }
  if (config.changeWindowEnabled && (typeChange || adminGrant || adminRevoke) && !insideChangeWindow(row.occurredAt, config)) {
    return {
      kind: 'outside_change_window',
      severity: 'medium',
      subject: { type: 'admin', id: target ?? 'unknown', display: meta.email ?? null },
      title: 'Administrator privilege change outside the change window',
      summary: `An administrator privilege change (${row.action}) happened outside the configured change window.`,
      target,
      reason: null,
    };
  }
  return null;
}

export const privilegeChange = Object.freeze({
  id: 'iam.privilege_change',
  version: 1,
  title: 'Sensitive administrator privilege change',
  description: 'Super-administrator grants, refused (including self-targeted) privilege changes and, optionally, changes outside the change window.',
  source: 'audit_log',
  severity: 'high',
  defaults: Object.freeze({
    enabled: true,
    superRoleNames: Object.freeze(['super']),
    changeWindowEnabled: false,
    changeWindowTimeZone: 'UTC',
    changeWindowDays: Object.freeze([1, 2, 3, 4, 5]),
    changeWindowStartHour: 8,
    changeWindowEndHour: 18,
  }),
  params: Object.freeze({
    superRoleNames: strings({ maxItems: 10, maxLength: 64 }),
    changeWindowEnabled: bool(),
    changeWindowTimeZone: timeZone(),
    changeWindowDays: ints(0, 6, { maxItems: 7 }),
    changeWindowStartHour: int(0, 23),
    changeWindowEndHour: int(1, 24),
  }),

  async evaluate({ from, to, config, sources }) {
    const rows = await sources.listAuditEvents({ pairs: Object.values(PRIVILEGE_EVENTS), from, to });
    const detections = [];
    for (const row of rows) {
      const found = classify(row, config);
      if (!found) continue;
      const actor = actorOf(row);
      detections.push({
        subject: found.subject,
        dedupe: found.kind,
        severity: found.severity,
        tenantId: row.tenantId ?? null,
        title: found.title,
        summary: found.summary,
        windowStart: row.occurredAt,
        windowEnd: row.occurredAt,
        counts: { events: 1 },
        details: {
          kind: found.kind,
          action: row.action,
          actor,
          targetAdminId: found.target,
          reason: found.reason,
          roleName: eventMetadata(row).roleName ?? null,
          changes: eventMetadata(row).changes ?? null,
        },
        refs: [ref('audit_log', row._id, row.occurredAt, `${row.action} by ${actor.type}:${actor.id ?? '-'}`)],
      });
    }
    return detections;
  },
});

/** Admin the MFA event is about (resource first, then the reset target, then the actor). */
function mfaAdminId(row) {
  if (row.resourceType === 'admin' && row.resourceId) return String(row.resourceId);
  if (row.action === MFA_EVENTS.RESET_BY_ADMIN.action) {
    const target = eventMetadata(row).targetAdminId;
    return target ? String(target) : null;
  }
  if (row.actorType === 'admin' && row.actorId) return String(row.actorId);
  return null;
}

export const adminMfaChange = Object.freeze({
  id: 'auth.admin_mfa_change',
  version: 2,
  title: 'Admin MFA disabled or re-enrolled',
  description: 'Multi-factor authentication was disabled for a platform administrator (or reset by another administrator), or enrolled again after an earlier enrolment or disable.',
  source: 'audit_log',
  severity: 'high',
  defaults: Object.freeze({ enabled: true, reenrolLookbackDays: 90 }),
  params: Object.freeze({ reenrolLookbackDays: int(1, 3650) }),

  async evaluate({ from, to, config, sources }) {
    const rows = await sources.listAuditEvents({ pairs: Object.values(MFA_EVENTS), from, to });
    const detections = [];
    for (const row of rows) {
      const adminId = mfaAdminId(row);
      if (!adminId) continue;
      let kind;
      let prior = null;
      if (row.action === MFA_EVENTS.DISABLED.action) {
        kind = 'mfa_disabled';
      } else if (row.action === MFA_EVENTS.RESET_BY_ADMIN.action) {
        kind = 'mfa_reset_by_admin';
      } else {
        prior = await sources.findLatestAuditEvent({
          pairs: REENROL_PRIOR_EVENTS,
          since: new Date(new Date(row.occurredAt).getTime() - config.reenrolLookbackDays * DAY_MS),
          before: row.occurredAt,
          extra: {
            $and: [{
              $or: [
                { resourceType: 'admin', resourceId: adminId },
                { actorType: 'admin', actorId: adminId },
              ],
            }],
          },
        });
        if (!prior) continue;
        kind = 'mfa_re_enrolled';
      }
      const display = row.actorType === 'admin' && String(row.actorId) === adminId ? row.actorDisplay || null : null;
      detections.push({
        subject: { type: 'admin', id: adminId, display },
        dedupe: kind,
        title: kind === 'mfa_disabled'
          ? 'MFA disabled for an administrator'
          : kind === 'mfa_reset_by_admin' ? 'Administrator MFA reset by another administrator' : 'Administrator re-enrolled MFA',
        summary: kind === 'mfa_disabled'
          ? `Multi-factor authentication was disabled for the administrator ${display ?? adminId}.`
          : kind === 'mfa_reset_by_admin'
            ? `The administrator ${row.actorDisplay || row.actorId || 'unknown'} reset multi-factor authentication for the administrator ${adminId}.`
            : `The administrator ${display ?? adminId} enrolled MFA again after an earlier ${prior.action === MFA_EVENTS.DISABLED.action ? 'disable' : 'enrolment'}.`,
        windowStart: prior?.occurredAt ?? row.occurredAt,
        windowEnd: row.occurredAt,
        counts: { events: 1 },
        details: {
          kind,
          actor: actorOf(row),
          previousEvent: prior ? { action: prior.action, at: prior.occurredAt } : null,
        },
        refs: [
          ...(prior ? [ref('audit_log', prior._id, prior.occurredAt, prior.action)] : []),
          ref('audit_log', row._id, row.occurredAt, row.action),
        ],
      });
    }
    return detections;
  },
});

export default [privilegeChange, adminMfaChange];
