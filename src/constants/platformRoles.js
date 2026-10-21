/**
 * Built-in platform (admin-plane) role catalogue (roadmap 2.1).
 *
 * WHY IT EXISTS
 *   Platform administrators used to receive one all-permissions bootstrap
 *   role named after their `adminType`, so a support operator was as
 *   powerful as a super admin and no read-only auditor could exist. This
 *   file is the single source of truth for the four built-in platform roles
 *   and their explicit grants (audit doc 05, section 3 target matrix):
 *
 *     super_admin       every platform catalogue key (break-glass owner)
 *     platform_admin    tenant lifecycle (no archive / ownership / secrets),
 *                       onboarding, plan catalogue edits, read access to
 *                       admins, audit, monitoring and billing
 *     support_operator  support tooling plus read access to the tenants it
 *                       can reach (its `tenantScope` when set)
 *     auditor           read-only everywhere, including audit-log export
 *
 * GUARDRAILS (enforced elsewhere, declared here)
 *   - `adminType` is the privilege ceiling: a built-in role ranked above the
 *     admin's type cannot be granted (`admin.service#assignRole`), and
 *     lowering an admin's type revokes built-in roles above the new type.
 *   - An `auditor` admin is refused every action outside READ_ONLY_ACTIONS
 *     by the permission middleware, whatever custom role it holds.
 *   - Built-in roles are converged to exactly these lists by
 *     `adminBootstrap.service#syncPlatformCatalogue` (`npm run
 *     db:permissions`), and their permissions cannot be edited over HTTP.
 *
 * EXTENDING (later roadmap packages: MFA policy, platform settings,
 * support access, compliance)
 *   1. Register any new module in `models/Module.js` (BUILTIN_MODULES,
 *      IAM_MODULES or BILLING_MODULES) so the catalogue creates its keys.
 *   2. Append the key to the `permissions` list of each built-in role below
 *      that should hold it. `super_admin` holds every catalogue key.
 *   3. Gate the route with `permission(module, action)` and an
 *      `adminScope.*` guard; `npm run ci:check-routes` enforces the former.
 *   4. Operators run `npm run db:permissions -- --apply` to converge
 *      existing deployments.
 *   Auditor keys must stay read-only: this module throws at load time
 *   otherwise.
 */

/** Actions that never change state. Exports are reads (and are audited). */
export const READ_ONLY_ACTIONS = Object.freeze(['view', 'export']);

/** Role names of the four built-in platform roles. */
export const PLATFORM_ROLE_NAMES = Object.freeze({
  SUPER: 'super_admin',
  PLATFORM: 'platform_admin',
  SUPPORT: 'support_operator',
  AUDITOR: 'auditor',
});

/**
 * Privilege ceiling per `adminType` (higher = more privileged). Mirrors
 * the role ceiling Super > Platform > Support > Auditor (doc 05, 4.1).
 */
export const ADMIN_TYPE_RANK = Object.freeze({
  auditor: 1,
  support: 2,
  platform: 3,
  super: 4,
});

/**
 * Names of the pre-2.1 bootstrap roles (one all-permissions role per
 * adminType). `npm run db:platform-roles` moves admins off them.
 */
export const LEGACY_PLATFORM_ROLE_NAMES = Object.freeze(['super', 'platform', 'support']);

/** Platform-admin grants (doc 05 section 3, "Platform admin" column). */
const PLATFORM_ADMIN_PERMISSIONS = Object.freeze([
  // Tenants: view and lifecycle (suspend/disable/restore), onboarding and
  // invitations. Archive (`delete`), owner reassignment (`assign`) and
  // secret settings (`configure`) stay with super admins.
  'iam.tenants.view',
  'iam.tenants.create',
  'iam.tenants.update',
  'iam.tenants.suspend',
  'iam.tenants.restore',
  // backups: export a tenant's data (support-requested data portability).
  'iam.tenants.export',
  // Access requests: review and decide.
  'iam.access_requests.view',
  'iam.access_requests.approve',
  // Platform administrators, roles and permissions: view only.
  'iam.admins.view',
  'iam.roles.view',
  'iam.permissions.view',
  // Governance and operations: view.
  'audit_logs.view',
  'access_logs.view',
  'compliance.view',
  'monitoring.view',
  // retention: requeue a dead-lettered outbox email (operations).
  'monitoring.update',
  'support.view',
  // Reference data: maintain (no delete of catalogue entries).
  'master_data.view',
  'master_data.create',
  'master_data.update',
  'master_data.export',
  // Billing: view, and edit the plan catalogue (overrides are super-only).
  'billing.plans.view',
  'billing.plans.update',
  'billing.subscriptions.view',
  'billing.entitlements.view',
  // Platform configuration (non-security); the HTTP surfaces land in 2.4.
  'settings.view',
  'settings.update',
  'feature_flags.view',
  // config: platform admins manage the flag catalogue end to end.
  'feature_flags.create',
  'feature_flags.update',
  'feature_flags.delete',
  'email_templates.view',
  'email_templates.update',
  // detection: platform security alert triage.
  'security.alerts.view',
  'security.alerts.update',
]);

/** Support-operator grants: support tooling plus scoped tenant reads. */
const SUPPORT_OPERATOR_PERMISSIONS = Object.freeze([
  'iam.tenants.view',
  'audit_logs.view',
  'access_logs.view',
  'compliance.view',
  // Sanitised diagnostics (tenant lookups).
  'support.view',
  // Account recovery, session revocation, tenant broadcasts.
  'support.update',
  // Impersonation (redesigned as consented, time-boxed access in 2.3).
  'support.configure',
]);

/** Auditor grants: read-only, including audit and access-log export. */
const AUDITOR_PERMISSIONS = Object.freeze([
  'iam.admins.view',
  'iam.roles.view',
  'iam.permissions.view',
  'iam.tenants.view',
  'iam.access_requests.view',
  'audit_logs.view',
  'audit_logs.export',
  'access_logs.view',
  'access_logs.export',
  'compliance.view',
  'monitoring.view',
  'support.view',
  'master_data.view',
  'billing.plans.view',
  'billing.subscriptions.view',
  'billing.entitlements.view',
  'settings.view',
  'feature_flags.view',
  'email_templates.view',
  // detection:
  'security.alerts.view',
]);

/**
 * The built-in platform roles, most privileged first. `allCatalogue: true`
 * means "every key in the platform permission catalogue".
 */
export const PLATFORM_ROLES = Object.freeze([
  Object.freeze({
    name: PLATFORM_ROLE_NAMES.SUPER,
    label: 'Super Admin',
    adminType: 'super',
    description: 'Full platform control, including administrators, roles, archive and overrides.',
    allCatalogue: true,
    permissions: Object.freeze([]),
  }),
  Object.freeze({
    name: PLATFORM_ROLE_NAMES.PLATFORM,
    label: 'Platform Admin',
    adminType: 'platform',
    description: 'Tenant lifecycle, onboarding and plan catalogue; read access to administrators, audit and billing.',
    allCatalogue: false,
    permissions: PLATFORM_ADMIN_PERMISSIONS,
  }),
  Object.freeze({
    name: PLATFORM_ROLE_NAMES.SUPPORT,
    label: 'Support Operator',
    adminType: 'support',
    description: 'Support tooling and read access to the tenants within the operator\'s scope.',
    allCatalogue: false,
    permissions: SUPPORT_OPERATOR_PERMISSIONS,
  }),
  Object.freeze({
    name: PLATFORM_ROLE_NAMES.AUDITOR,
    label: 'Auditor',
    adminType: 'auditor',
    description: 'Read-only access to platform data, including audit and access-log exports.',
    allCatalogue: false,
    permissions: AUDITOR_PERMISSIONS,
  }),
]);

/** Built-in role an admin of each type maps to (migration, bootstrap). */
export const ROLE_FOR_ADMIN_TYPE = Object.freeze({
  super: PLATFORM_ROLE_NAMES.SUPER,
  platform: PLATFORM_ROLE_NAMES.PLATFORM,
  support: PLATFORM_ROLE_NAMES.SUPPORT,
  auditor: PLATFORM_ROLE_NAMES.AUDITOR,
});

/** Whether a permission key's action is read-only (`view` / `export`). */
export function isReadOnlyKey(key) {
  const value = String(key ?? '');
  return READ_ONLY_ACTIONS.includes(value.slice(value.lastIndexOf('.') + 1));
}

/** Whether an action name is read-only. */
export function isReadOnlyAction(action) {
  return READ_ONLY_ACTIONS.includes(String(action ?? '').toLowerCase());
}

/** The built-in role definition for `name`, or null. */
export function findPlatformRole(name) {
  return PLATFORM_ROLES.find((role) => role.name === name) ?? null;
}

/** Whether a stored role row is one of the built-in platform roles. */
export function isBuiltInPlatformRole(role) {
  if (!role) return false;
  if (role.tenantId !== null && role.tenantId !== undefined) return false;
  return Boolean(role.isSystem) && findPlatformRole(role.name) !== null;
}

/**
 * The exact permission keys a built-in role holds, given the platform
 * catalogue (needed for `allCatalogue` roles).
 *
 * @param {string} name - built-in role name.
 * @param {readonly string[]} catalogueKeys - every platform catalogue key.
 * @returns {string[]} sorted, de-duplicated keys.
 */
export function permissionsForPlatformRole(name, catalogueKeys = []) {
  const role = findPlatformRole(name);
  if (!role) return [];
  const keys = role.allCatalogue ? catalogueKeys : role.permissions;
  return [...new Set(keys)].sort();
}

// Load-time guard: the auditor must never hold a write permission.
for (const key of AUDITOR_PERMISSIONS) {
  if (!isReadOnlyKey(key)) {
    throw new Error(`platformRoles: auditor permission "${key}" is not read-only`);
  }
}

export default {
  READ_ONLY_ACTIONS,
  PLATFORM_ROLE_NAMES,
  ADMIN_TYPE_RANK,
  LEGACY_PLATFORM_ROLE_NAMES,
  PLATFORM_ROLES,
  ROLE_FOR_ADMIN_TYPE,
  isReadOnlyKey,
  isReadOnlyAction,
  findPlatformRole,
  isBuiltInPlatformRole,
  permissionsForPlatformRole,
};
