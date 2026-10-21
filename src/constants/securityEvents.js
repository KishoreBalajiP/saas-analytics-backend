/**
 * Security event catalogue (roadmap 2.5; findings gov.06, gov.08).
 *
 * THE ONE PLACE WHERE SECURITY EVENT NAMES ARE DEFINED.
 *
 * Every security-relevant action is recorded through
 * `services/securityEvent.service.js#securityEvent(KEY, details)`, which
 * writes an `AuditLog` row with `category: 'security'`, the `module` and
 * `action` below, the severity, the actor, tenant, ip, user agent and
 * request id. Rows are hash-chained like every other audit row and are
 * listed in the admin audit viewer under the "Security" filter
 * (`GET /api/v1/audit-logs?category=security`).
 *
 * HOW TO ADD AN EVENT
 *   1. Add a key here (UPPER_SNAKE) with a dotted `action`
 *      (`<area>.<thing>.<what happened>`), the `module` it belongs to and
 *      a severity: `info` (routine), `notice` (change worth reviewing),
 *      `warning` (privilege/credential change or refusal), `critical`
 *      (likely attack, e.g. refresh-token replay).
 *   2. Call `securityEvent('<KEY>', { ... })` at the call site (one line).
 *      Never pass secrets in `metadata`; credential-like keys are redacted
 *      anyway, but ids and reasons are what belongs there.
 *   3. Add the action to the frontend filter list if it should be offered
 *      as a quick filter (`features/admin/components/AuditViews.tsx`).
 *
 * EVENTS
 *   | Key                            | action                          | module                 | severity |
 *   |--------------------------------|---------------------------------|------------------------|----------|
 *   | LOGIN_SUCCEEDED                | auth.login.succeeded            | iam.auth               | info     |
 *   | LOGIN_FAILED                   | auth.login.failed               | iam.auth               | notice   |
 *   | LOCKOUT                        | auth.lockout                    | iam.auth               | warning  |
 *   | PASSWORD_RESET_REQUESTED       | auth.password_reset.requested   | iam.auth               | info     |
 *   | PASSWORD_RESET_COMPLETED       | auth.password_reset.completed   | iam.auth               | notice   |
 *   | MFA_ENROLLMENT_STARTED         | auth.mfa.enrollment_started     | iam.auth               | info     |
 *   | MFA_ENROLLED                   | auth.mfa.enrolled               | iam.auth               | notice   |
 *   | MFA_DISABLED                   | auth.mfa.disabled               | iam.auth               | warning  |
 *   | MFA_DISABLE_FAILED             | auth.mfa.disable_failed         | iam.auth               | warning  |
 *   | MFA_RECOVERY_CODE_USED         | auth.mfa.recovery_code_used     | iam.auth               | warning  |
 *   | SESSION_REVOKED                | auth.session.revoked            | iam.sessions           | info     |
 *   | SESSION_REPLAY_DETECTED        | auth.session.replay_detected    | iam.sessions           | critical |
 *   | PERMISSION_GRANTED             | rbac.permission.granted         | iam.roles              | notice   |
 *   | PERMISSION_REVOKED             | rbac.permission.revoked         | iam.roles              | notice   |
 *   | ROLE_GRANTED                   | rbac.role.granted               | iam.roles              | notice   |
 *   | ROLE_REVOKED                   | rbac.role.revoked               | iam.roles              | notice   |
 *   | ADMIN_PRIVILEGE_CHANGED        | admin.privilege.changed         | iam.admins             | warning  |
 *   | ADMIN_PRIVILEGE_CHANGE_DENIED  | admin.privilege.change_denied   | iam.admins             | warning  |
 *   | SUPPORT_IMPERSONATION_STARTED  | impersonate                     | support.impersonation  | warning  |
 *   | SUPPORT_IMPERSONATION_STOPPED  | impersonate.stop                | support.impersonation  | notice   |
 *   | API_KEY_CREATED                | api_key.created                 | api_keys               | notice   |
 *   | API_KEY_ROTATED                | api_key.rotated                 | api_keys               | notice   |
 *   | API_KEY_REVOKED                | api_key.revoked                 | api_keys               | notice   |
 *   | EMBED_TOKEN_CREATED            | embed_token.created             | embed                  | notice   |
 *   | EMBED_TOKEN_REVOKED            | embed_token.revoked             | embed                  | notice   |
 *   | REQUEST_DENIED                 | request.denied                  | security.access        | warning  |
 *   | USER_MFA_ENROLLMENT_ENFORCED   | auth.mfa.user_enrollment_enforced | iam.users            | notice   |
 *   | USER_MFA_RECOVERY_CODES_REGENERATED | auth.mfa.user_recovery_codes_regenerated | iam.users | notice |
 *   | USER_MFA_RESET_BY_OWNER        | auth.mfa.reset_by_owner         | iam.users              | warning  |
 *   | USER_MFA_RESET_DENIED          | auth.mfa.reset_denied           | iam.users              | warning  |
 *   | USER_STEP_UP_SUCCEEDED         | auth.step_up.user_succeeded     | iam.users              | info     |
 *   | USER_STEP_UP_FAILED            | auth.step_up.user_failed        | iam.users              | warning  |
 *   | WORKSPACE_MFA_POLICY_CHANGED   | workspace.mfa_policy.changed    | security               | warning  |
 *
 *   The two support impersonation events keep the action names the support
 *   surface has always written (`impersonate`, `impersonate.stop`), so
 *   existing queries, exports and the daily impersonation budget keep
 *   working; they are now also tagged `category: 'security'`.
 *
 *   `MFA_RECOVERY_CODE_USED` is reserved for the admin MFA recovery-code
 *   flow (a later roadmap package); nothing emits it yet.
 *
 * REQUEST_DENIED
 *   Written by `middleware/audit.middleware.js#auditDenied` for every 401/403
 *   refused by authentication/authorization middleware (missing permission,
 *   cross-tenant request, wrong admin type, suspended account, revoked
 *   session, forged token, invalid API key). `metadata` carries the route
 *   pattern, the reason code and the requested tenant. It is rate-limited:
 *   one row per (actor or ip, tenant, route, reason) per
 *   `AUDIT_DENIED_WINDOW_SEC`, and at most `AUDIT_DENIED_MAX_PER_WINDOW` rows
 *   per process per window, so it cannot be used to flood the trail.
 *   Expired access tokens and requests without any credential are not
 *   recorded (routine traffic, not refusals of an identity).
 */

/** Severity levels, lowest to highest. */
export const SECURITY_SEVERITIES = Object.freeze(['info', 'notice', 'warning', 'critical']);

/** Audit categories (`AuditLog.category`). */
export const AUDIT_CATEGORIES = Object.freeze(['change', 'security']);

function define(action, module, severity, { result = 'success' } = {}) {
  return Object.freeze({ action, module, severity, result });
}

const FAILURE = { result: 'failure' };

export const SECURITY_EVENTS = Object.freeze({
  LOGIN_SUCCEEDED: define('auth.login.succeeded', 'iam.auth', 'info'),
  LOGIN_FAILED: define('auth.login.failed', 'iam.auth', 'notice', FAILURE),
  LOCKOUT: define('auth.lockout', 'iam.auth', 'warning', FAILURE),
  PASSWORD_RESET_REQUESTED: define('auth.password_reset.requested', 'iam.auth', 'info'),
  PASSWORD_RESET_COMPLETED: define('auth.password_reset.completed', 'iam.auth', 'notice'),
  MFA_ENROLLMENT_STARTED: define('auth.mfa.enrollment_started', 'iam.auth', 'info'),
  MFA_ENROLLED: define('auth.mfa.enrolled', 'iam.auth', 'notice'),
  MFA_DISABLED: define('auth.mfa.disabled', 'iam.auth', 'warning'),
  MFA_DISABLE_FAILED: define('auth.mfa.disable_failed', 'iam.auth', 'warning', FAILURE),
  MFA_RECOVERY_CODE_USED: define('auth.mfa.recovery_code_used', 'iam.auth', 'warning'),
  SESSION_REVOKED: define('auth.session.revoked', 'iam.sessions', 'info'),
  SESSION_REPLAY_DETECTED: define('auth.session.replay_detected', 'iam.sessions', 'critical', FAILURE),
  PERMISSION_GRANTED: define('rbac.permission.granted', 'iam.roles', 'notice'),
  PERMISSION_REVOKED: define('rbac.permission.revoked', 'iam.roles', 'notice'),
  ROLE_GRANTED: define('rbac.role.granted', 'iam.roles', 'notice'),
  ROLE_REVOKED: define('rbac.role.revoked', 'iam.roles', 'notice'),
  ADMIN_PRIVILEGE_CHANGED: define('admin.privilege.changed', 'iam.admins', 'warning'),
  ADMIN_PRIVILEGE_CHANGE_DENIED: define('admin.privilege.change_denied', 'iam.admins', 'warning', FAILURE),
  SUPPORT_IMPERSONATION_STARTED: define('impersonate', 'support.impersonation', 'warning'),
  SUPPORT_IMPERSONATION_STOPPED: define('impersonate.stop', 'support.impersonation', 'notice'),
  API_KEY_CREATED: define('api_key.created', 'api_keys', 'notice'),
  API_KEY_ROTATED: define('api_key.rotated', 'api_keys', 'notice'),
  API_KEY_REVOKED: define('api_key.revoked', 'api_keys', 'notice'),
  EMBED_TOKEN_CREATED: define('embed_token.created', 'embed', 'notice'),
  EMBED_TOKEN_REVOKED: define('embed_token.revoked', 'embed', 'notice'),
  REQUEST_DENIED: define('request.denied', 'security.access', 'warning', FAILURE),
  // adminauth (roadmap 2.2): MFA policy, recovery codes, admin-assisted
  // credential resets, step-up and admin invitations.
  MFA_ENROLLMENT_ENFORCED: define('auth.mfa.enrollment_enforced', 'iam.admins', 'notice'),
  MFA_RECOVERY_CODES_REGENERATED: define('auth.mfa.recovery_codes_regenerated', 'iam.admins', 'notice'),
  MFA_RESET_BY_ADMIN: define('auth.mfa.reset_by_admin', 'iam.admins', 'warning'),
  PASSWORD_RESET_BY_ADMIN: define('auth.password.reset_by_admin', 'iam.admins', 'warning'),
  ADMIN_CREDENTIAL_RESET_DENIED: define('auth.credentials.reset_denied', 'iam.admins', 'warning', FAILURE),
  STEP_UP_SUCCEEDED: define('auth.step_up.succeeded', 'iam.admins', 'info'),
  STEP_UP_FAILED: define('auth.step_up.failed', 'iam.admins', 'warning', FAILURE),
  ADMIN_INVITATION_CREATED: define('iam.admin_invitation.created', 'iam.admins', 'notice'),
  ADMIN_INVITATION_RESENT: define('iam.admin_invitation.resent', 'iam.admins', 'info'),
  ADMIN_INVITATION_REVOKED: define('iam.admin_invitation.revoked', 'iam.admins', 'notice'),
  ADMIN_INVITATION_ACCEPTED: define('iam.admin_invitation.accepted', 'iam.admins', 'notice'),
  // onboarding: self-service password change.
  PASSWORD_CHANGED: define('auth.password.changed', 'iam.auth', 'notice'),
  // mfa-tenant (roadmap 4.E1): tenant-user MFA. Enrolment, confirmation,
  // disable and recovery-code use reuse the generic `auth.mfa.*` events
  // above (with the user's tenant); these cover the workspace policy, the
  // Owner-assisted reset and tenant step-up.
  USER_MFA_ENROLLMENT_ENFORCED: define('auth.mfa.user_enrollment_enforced', 'iam.users', 'notice'),
  USER_MFA_RECOVERY_CODES_REGENERATED: define('auth.mfa.user_recovery_codes_regenerated', 'iam.users', 'notice'),
  USER_MFA_RESET_BY_OWNER: define('auth.mfa.reset_by_owner', 'iam.users', 'warning'),
  USER_MFA_RESET_DENIED: define('auth.mfa.reset_denied', 'iam.users', 'warning', FAILURE),
  USER_STEP_UP_SUCCEEDED: define('auth.step_up.user_succeeded', 'iam.users', 'info'),
  USER_STEP_UP_FAILED: define('auth.step_up.user_failed', 'iam.users', 'warning', FAILURE),
  WORKSPACE_MFA_POLICY_CHANGED: define('workspace.mfa_policy.changed', 'security', 'warning'),
  // members (roadmap 2.10): workspace membership and lifecycle. Tenant-user
  // step-up failures share STEP_UP_FAILED above.
  MEMBER_DEACTIVATED: define('member.deactivated', 'iam.users', 'warning'),
  MEMBER_REACTIVATED: define('member.reactivated', 'iam.users', 'notice'),
  MEMBER_REMOVED: define('member.removed', 'iam.users', 'warning'),
  TENANT_ROLE_CHANGED: define('rbac.tenant_role.changed', 'iam.roles', 'notice'),
  OWNERSHIP_TRANSFERRED: define('tenant.ownership.transferred', 'iam.tenants', 'warning'),
  TENANT_DELETION_REQUESTED: define('tenant.deletion.requested', 'iam.tenants', 'critical'),
  TENANT_DELETION_CANCELLED: define('tenant.deletion.cancelled', 'iam.tenants', 'warning'),
  TENANT_PURGED: define('tenant.purged', 'iam.tenants', 'critical'),
  TENANT_PURGE_FAILED: define('tenant.purge.failed', 'iam.tenants', 'critical', FAILURE),
  // backups (roadmap 2.9): tenant data export is bulk data egress.
  TENANT_EXPORT_REQUESTED: define('tenant_export.requested', 'data_exports', 'notice'),
  TENANT_EXPORT_DOWNLOAD_ISSUED: define('tenant_export.download_issued', 'data_exports', 'notice'),
  TENANT_EXPORT_DOWNLOADED: define('tenant_export.downloaded', 'data_exports', 'notice'),
  // support:
  SUPPORT_ACCESS_GRANTED: define('support.access.granted', 'support.access', 'notice'),
  SUPPORT_ACCESS_REVOKED: define('support.access.revoked', 'support.access', 'notice'),
  SUPPORT_BREAK_GLASS_REQUESTED: define('support.break_glass.requested', 'support.access', 'warning'),
  SUPPORT_BREAK_GLASS_APPROVED: define('support.break_glass.approved', 'support.access', 'critical'),
  SUPPORT_BREAK_GLASS_DENIED: define('support.break_glass.denied', 'support.access', 'notice', FAILURE),
  SUPPORT_IMPERSONATION_REFUSED: define('support.impersonation.refused', 'support.impersonation', 'warning', FAILURE),
  // detection:
  SECURITY_ALERT_RAISED: define('security.alert.raised', 'security.alerts', 'warning'),
  SECURITY_ALERT_ACKNOWLEDGED: define('security.alert.acknowledged', 'security.alerts', 'notice'),
  SECURITY_ALERT_FALSE_POSITIVE: define('security.alert.false_positive', 'security.alerts', 'notice'),
  SECURITY_ALERT_RESOLVED: define('security.alert.resolved', 'security.alerts', 'notice'),
  SECURITY_ALERT_NOTIFICATION_FAILED: define('security.alert.notification_failed', 'security.alerts', 'warning', FAILURE),
});

/** Every security action name, for validators and the frontend filter list. */
export const SECURITY_EVENT_ACTIONS = Object.freeze(
  Object.values(SECURITY_EVENTS).map((event) => event.action),
);

export default {
  SECURITY_EVENTS,
  SECURITY_EVENT_ACTIONS,
  SECURITY_SEVERITIES,
  AUDIT_CATEGORIES,
};
