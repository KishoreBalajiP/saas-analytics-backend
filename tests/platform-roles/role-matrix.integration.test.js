/**
 * Platform role permission matrix (roadmap 2.1, audit doc 05 section 3).
 *
 * For each built-in platform role (super_admin, platform_admin,
 * support_operator, auditor) and EVERY platform-admin route, asserts that
 * the route is allowed (the permission layer lets the request through) or
 * refused with 403 by the permission middleware.
 *
 * The expected matrix below is the specification, written out by hand (it
 * is deliberately NOT derived from `src/constants/platformRoles.js`), and a
 * static scan of `src/routes` proves the table covers every admin route.
 *
 * Requests use non-existent ids or invalid bodies so an allowed request
 * stops at a 404/422 (or 2xx for reads) without changing data.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import rbacCache from '../../src/services/rbac.cache.service.js';
import roleService from '../../src/services/role.service.js';
import adminService from '../../src/services/admin.service.js';
import { PLATFORM_ROLES, isReadOnlyKey } from '../../src/constants/platformRoles.js';
import { PLATFORM_CATALOGUE_KEYS } from '../../src/services/adminBootstrap.service.js';
import { stripComments, extractRouteCalls } from '../../scripts/ci/check-routes.js';
import { seedPlatformRoles, adminSession, createAdmin, loginAdmin } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOID = '0a1b2c3d4e5f60718293a4b5';
const NOID2 = '0a1b2c3d4e5f60718293a4b6';

// S = super_admin, P = platform_admin, U = support_operator, A = auditor.
// [method, route pattern, request path, permission key, allowed roles, body]
const MATRIX = [
  // Platform administrators
  ['GET', '/admin/admins', '/admin/admins', 'iam.admins.view', 'SPA'],
  ['POST', '/admin/admins', '/admin/admins', 'iam.admins.create', 'S', {}],
  ['GET', '/admin/admins/:id', `/admin/admins/${NOID}`, 'iam.admins.view', 'SPA'],
  ['PATCH', '/admin/admins/:id', `/admin/admins/${NOID}`, 'iam.admins.update', 'S', { name: 'x' }],
  ['POST', '/admin/admins/:id/suspend', `/admin/admins/${NOID}/suspend`, 'iam.admins.suspend', 'S', {}],
  ['POST', '/admin/admins/:id/restore', `/admin/admins/${NOID}/restore`, 'iam.admins.restore', 'S', {}],
  ['POST', '/admin/admins/:id/roles', `/admin/admins/${NOID}/roles`, 'iam.admins.assign', 'S', {}],
  ['DELETE', '/admin/admins/:id/roles/:roleId', `/admin/admins/${NOID}/roles/${NOID2}`, 'iam.admins.assign', 'S'],
  ['GET', '/admin/admins/:id/audit', `/admin/admins/${NOID}/audit`, 'iam.admins.view', 'SPA'],
  // adminauth: admin invitations and admin-assisted credential resets.
  ['GET', '/admin/admins/invitations', '/admin/admins/invitations', 'iam.admins.view', 'SPA'],
  ['POST', '/admin/admins/:id/invitation/resend', `/admin/admins/${NOID}/invitation/resend`, 'iam.admins.create', 'S', {}],
  ['POST', '/admin/admins/:id/invitation/revoke', `/admin/admins/${NOID}/invitation/revoke`, 'iam.admins.delete', 'S', {}],
  ['POST', '/admin/admins/:id/mfa/reset', `/admin/admins/${NOID}/mfa/reset`, 'iam.admins.configure', 'S', { reason: 'matrix check' }],
  ['POST', '/admin/admins/:id/password/reset', `/admin/admins/${NOID}/password/reset`, 'iam.admins.configure', 'S', { reason: 'matrix check' }],
  // Platform dashboard
  ['GET', '/admin/dashboard/summary', '/admin/dashboard/summary', 'iam.tenants.view', 'SPUA'],
  // support (roadmap 2.3): diagnostics, consent / break-glass grants, sessions.
  ['GET', '/support/tenants/:id/diagnostics', `/support/tenants/${NOID}/diagnostics`, 'support.view', 'SPUA'],
  ['GET', '/support/access-grants', '/support/access-grants', 'support.view', 'SPUA'],
  ['POST', '/support/access-grants/break-glass', '/support/access-grants/break-glass', 'support.configure', 'SU', {}],
  ['POST', '/support/access-grants/:id/approve', `/support/access-grants/${NOID}/approve`, 'support.approve', 'S', {}],
  ['POST', '/support/access-grants/:id/deny', `/support/access-grants/${NOID}/deny`, 'support.approve', 'S', {}],
  ['POST', '/support/access-grants/:id/revoke', `/support/access-grants/${NOID}/revoke`, 'support.configure', 'SU', {}],
  ['GET', '/support/impersonations', '/support/impersonations', 'support.view', 'SPUA'],
  // detection (roadmap 2.6): platform security alerts.
  ['GET', '/admin/security-alerts', '/admin/security-alerts', 'security.alerts.view', 'SPA'],
  ['GET', '/admin/security-alerts/rules', '/admin/security-alerts/rules', 'security.alerts.view', 'SPA'],
  ['GET', '/admin/security-alerts/:id', `/admin/security-alerts/${NOID}`, 'security.alerts.view', 'SPA'],
  ['POST', '/admin/security-alerts/:id/acknowledge', `/admin/security-alerts/${NOID}/acknowledge`, 'security.alerts.update', 'SP', {}],
  ['POST', '/admin/security-alerts/:id/false-positive', `/admin/security-alerts/${NOID}/false-positive`, 'security.alerts.update', 'SP', {}],
  ['POST', '/admin/security-alerts/:id/resolve', `/admin/security-alerts/${NOID}/resolve`, 'security.alerts.update', 'SP', {}],
  // members: workspace deletion oversight (roadmap 2.10).
  ['GET', '/admin/tenant-deletions', '/admin/tenant-deletions', 'iam.tenants.view', 'SPUA'],
  ['GET', '/tenants/:id/deletion', `/tenants/${NOID}/deletion`, 'iam.tenants.view', 'SPUA'],
  ['POST', '/tenants/:id/deletion/cancel', `/tenants/${NOID}/deletion/cancel`, 'iam.tenants.restore', 'SP', {}],
  // config: platform settings, feature flags and email templates (roadmap 2.4).
  ['GET', '/settings', '/settings', 'settings.view', 'SPA'],
  ['GET', '/settings/:key', '/settings/matrix.key', 'settings.view', 'SPA'],
  ['PUT', '/settings/:key', '/settings/matrix.key', 'settings.update', 'SP', {}],
  ['POST', '/settings/:key/reset', '/settings/matrix.key/reset', 'settings.update', 'SP', {}],
  ['GET', '/settings/:key/history', '/settings/matrix.key/history', 'settings.view', 'SPA'],
  ['POST', '/settings/:key/rollback', '/settings/matrix.key/rollback', 'settings.update', 'SP', {}],
  ['GET', '/settings/:key/secret', '/settings/matrix.key/secret', 'settings.secrets.view', 'S'],
  ['GET', '/feature-flags', '/feature-flags', 'feature_flags.view', 'SPA'],
  ['POST', '/feature-flags', '/feature-flags', 'feature_flags.create', 'SP', {}],
  ['GET', '/feature-flags/preview', '/feature-flags/preview', 'feature_flags.view', 'SPA'],
  ['GET', '/feature-flags/:key', '/feature-flags/matrix_key', 'feature_flags.view', 'SPA'],
  ['PATCH', '/feature-flags/:key', '/feature-flags/matrix_key', 'feature_flags.update', 'SP', {}],
  ['DELETE', '/feature-flags/:key', '/feature-flags/matrix_key', 'feature_flags.delete', 'SP', {}],
  ['GET', '/feature-flags/:key/history', '/feature-flags/matrix_key/history', 'feature_flags.view', 'SPA'],
  ['POST', '/feature-flags/:key/rollback', '/feature-flags/matrix_key/rollback', 'feature_flags.update', 'SP', {}],
  ['GET', '/email-templates', '/email-templates', 'email_templates.view', 'SPA'],
  ['GET', '/email-templates/:key', '/email-templates/auth.password_reset', 'email_templates.view', 'SPA'],
  ['PUT', '/email-templates/:key', '/email-templates/auth.password_reset', 'email_templates.update', 'SP', {}],
  ['POST', '/email-templates/:key/reset', '/email-templates/auth.password_reset/reset', 'email_templates.update', 'SP', {}],
  ['POST', '/email-templates/:key/preview', '/email-templates/auth.password_reset/preview', 'email_templates.view', 'SPA', {}],
  ['GET', '/email-templates/:key/history', '/email-templates/auth.password_reset/history', 'email_templates.view', 'SPA'],
  ['POST', '/email-templates/:key/rollback', '/email-templates/auth.password_reset/rollback', 'email_templates.update', 'SP', {}],
  // Tenants
  ['POST', '/tenants', '/tenants', 'iam.tenants.create', 'SP', {}],
  ['GET', '/tenants', '/tenants', 'iam.tenants.view', 'SPUA'],
  ['GET', '/tenants/:id', `/tenants/${NOID}`, 'iam.tenants.view', 'SPUA'],
  ['PATCH', '/tenants/:id', `/tenants/${NOID}`, 'iam.tenants.update', 'SP', {}],
  ['POST', '/tenants/:id/suspend', `/tenants/${NOID}/suspend`, 'iam.tenants.suspend', 'SP', {}],
  ['POST', '/tenants/:id/restore', `/tenants/${NOID}/restore`, 'iam.tenants.restore', 'SP', {}],
  ['POST', '/tenants/:id/disable', `/tenants/${NOID}/disable`, 'iam.tenants.suspend', 'SP', {}],
  ['POST', '/tenants/:id/archive', `/tenants/${NOID}/archive`, 'iam.tenants.delete', 'S', {}],
  ['POST', '/tenants/:id/init', `/tenants/${NOID}/init`, 'iam.tenants.create', 'SP', {}],
  ['GET', '/tenants/:id/members', `/tenants/${NOID}/members`, 'iam.tenants.view', 'SPUA'],
  ['GET', '/tenants/:id/stats', `/tenants/${NOID}/stats`, 'iam.tenants.view', 'SPUA'],
  ['GET', '/tenants/:id/billing', `/tenants/${NOID}/billing`, 'iam.tenants.view', 'SPUA'],
  // backups: tenant data export (roadmap 2.9).
  ['GET', '/tenants/:id/data-exports', `/tenants/${NOID}/data-exports`, 'iam.tenants.view', 'SPUA'],
  ['POST', '/tenants/:id/data-exports', `/tenants/${NOID}/data-exports`, 'iam.tenants.export', 'SP', {}],
  ['GET', '/tenants/:id/data-exports/:exportId', `/tenants/${NOID}/data-exports/tex_00000000000000000000000000`, 'iam.tenants.view', 'SPUA'],
  ['POST', '/tenants/:id/data-exports/:exportId/download-url', `/tenants/${NOID}/data-exports/tex_00000000000000000000000000/download-url`, 'iam.tenants.export', 'SP', {}],
  ['DELETE', '/tenants/:id/data-exports/:exportId', `/tenants/${NOID}/data-exports/tex_00000000000000000000000000`, 'iam.tenants.export', 'SP'],
  ['GET', '/tenants/:id/settings', `/tenants/${NOID}/settings`, 'iam.tenants.view', 'SPUA'],
  ['GET', '/tenants/:id/settings', `/tenants/${NOID}/settings?includeSecrets=true`, 'settings.secrets.view', 'S'],
  ['PATCH', '/tenants/:id/settings', `/tenants/${NOID}/settings`, 'iam.tenants.configure', 'S', {}],
  ['POST', '/tenants/:id/owner', `/tenants/${NOID}/owner`, 'iam.tenants.assign', 'S', {}],
  ['GET', '/tenants/:id/invitations', `/tenants/${NOID}/invitations`, 'iam.tenants.view', 'SPUA'],
  ['POST', '/tenants/:id/invitations', `/tenants/${NOID}/invitations`, 'iam.tenants.create', 'SP', {}],
  ['POST', '/tenants/:id/invitations/resend', `/tenants/${NOID}/invitations/resend`, 'iam.tenants.update', 'SP', {}],
  ['POST', '/tenants/:id/invitations/:invitationId/revoke', `/tenants/${NOID}/invitations/${NOID2}/revoke`, 'iam.tenants.update', 'SP', {}],
  // Roles and the permission catalogue
  ['GET', '/roles', '/roles', 'iam.roles.view', 'SPA'],
  ['POST', '/roles', '/roles', 'iam.roles.create', 'S', {}],
  ['GET', '/roles/:id', `/roles/${NOID}`, 'iam.roles.view', 'SPA'],
  ['PATCH', '/roles/:id', `/roles/${NOID}`, 'iam.roles.update', 'S', {}],
  ['DELETE', '/roles/:id', `/roles/${NOID}`, 'iam.roles.delete', 'S'],
  ['POST', '/roles/:id/permissions', `/roles/${NOID}/permissions`, 'iam.roles.assign', 'S', {}],
  ['DELETE', '/roles/:id/permissions', `/roles/${NOID}/permissions`, 'iam.roles.assign', 'S', {}],
  ['GET', '/permissions', '/permissions', 'iam.permissions.view', 'SPA'],
  ['POST', '/permissions', '/permissions', 'iam.permissions.create', 'S', {}],
  ['DELETE', '/permissions', '/permissions', 'iam.permissions.delete', 'S', {}],
  ['GET', '/permissions/modules', '/permissions/modules', 'iam.permissions.view', 'SPA'],
  ['POST', '/permissions/modules', '/permissions/modules', 'iam.permissions.create', 'S', {}],
  ['GET', '/permissions/modules/:key/actions', '/permissions/modules/zz_none/actions', 'iam.permissions.view', 'SPA'],
  ['POST', '/permissions/bulk', '/permissions/bulk', 'iam.permissions.create', 'S', {}],
  // Master data (writes only; reads are public)
  ['POST', '/master-data/:catalogue', '/master-data/countries', 'master_data.create', 'SP', {}],
  ['PATCH', '/master-data/:catalogue/:id', `/master-data/countries/${NOID}`, 'master_data.update', 'SP', {}],
  ['DELETE', '/master-data/:catalogue/:id', `/master-data/countries/${NOID}`, 'master_data.delete', 'S'],
  ['POST', '/master-data/:catalogue/import', '/master-data/countries/import', 'master_data.create', 'SP', {}],
  ['POST', '/master-data/:catalogue/export', '/master-data/countries/export', 'master_data.export', 'SP', {}],
  // Monitoring
  ['GET', '/monitoring/health/system', '/monitoring/health/system', 'monitoring.view', 'SPA'],
  ['GET', '/monitoring/health/db', '/monitoring/health/db', 'monitoring.view', 'SPA'],
  ['GET', '/monitoring/health/websocket', '/monitoring/health/websocket', 'monitoring.view', 'SPA'],
  ['GET', '/monitoring/health/queue', '/monitoring/health/queue', 'monitoring.view', 'SPA'],
  ['GET', '/monitoring/health/scheduler', '/monitoring/health/scheduler', 'monitoring.view', 'SPA'],
  ['GET', '/monitoring/jobs/runs', '/monitoring/jobs/runs', 'monitoring.view', 'SPA'],
  // observability: redis + smtp probes (roadmap 2.8).
  ['GET', '/monitoring/health/redis', '/monitoring/health/redis', 'monitoring.view', 'SPA'],
  ['GET', '/monitoring/health/smtp', '/monitoring/health/smtp', 'monitoring.view', 'SPA'],
  ['GET', '/monitoring/health/storage', '/monitoring/health/storage', 'monitoring.view', 'SPA'],
  ['GET', '/monitoring/health/connectors', '/monitoring/health/connectors', 'monitoring.view', 'SPA'],
  ['GET', '/monitoring/health/aggregate', '/monitoring/health/aggregate', 'monitoring.view', 'SPA'],
  ['GET', '/monitoring/metrics', '/monitoring/metrics', 'monitoring.view', 'SPA'],
  ['GET', '/monitoring/health/mail', '/monitoring/health/mail', 'monitoring.view', 'SPA'],
  ['GET', '/monitoring/outbox', '/monitoring/outbox', 'monitoring.view', 'SPA'],
  ['POST', '/monitoring/outbox/:id/requeue', `/monitoring/outbox/${NOID}/requeue`, 'monitoring.update', 'SP', {}],
  ['GET', '/monitoring/retention', '/monitoring/retention', 'monitoring.view', 'SPA'],
  // Audit logs (auditor: view AND export)
  ['GET', '/audit-logs', '/audit-logs', 'audit_logs.view', 'SPUA'],
  ['GET', '/audit-logs/modules/:module', '/audit-logs/modules/iam.admins', 'audit_logs.view', 'SPUA'],
  ['POST', '/audit-logs/export', '/audit-logs/export', 'audit_logs.export', 'SA', { format: 'xml' }],
  ['GET', '/audit-logs/export/:exportId', '/audit-logs/export/exp_missing', 'audit_logs.view', 'SPUA'],
  ['GET', '/audit-logs/:id', `/audit-logs/${NOID}`, 'audit_logs.view', 'SPUA'],
  // Access logs
  ['GET', '/access-logs', '/access-logs', 'access_logs.view', 'SPUA'],
  ['GET', '/access-logs/top-paths', '/access-logs/top-paths', 'access_logs.view', 'SPUA'],
  ['GET', '/access-logs/top-errors', '/access-logs/top-errors', 'access_logs.view', 'SPUA'],
  ['GET', '/access-logs/login-attempts', '/access-logs/login-attempts', 'access_logs.view', 'SPUA'],
  ['POST', '/access-logs/export', '/access-logs/export', 'access_logs.export', 'SA', { format: 'xml' }],
  ['GET', '/access-logs/export/:exportId', '/access-logs/export/exp_missing', 'access_logs.view', 'SPUA'],
  // Compliance (admin surface)
  ['POST', '/compliance/requests', '/compliance/requests', 'compliance.create', 'S', {}],
  ['GET', '/compliance/requests', '/compliance/requests', 'compliance.view', 'SPUA'],
  ['GET', '/compliance/requests/:id', '/compliance/requests/dsr_missing', 'compliance.view', 'SPUA'],
  ['POST', '/compliance/requests/:id/cancel', '/compliance/requests/dsr_missing/cancel', 'compliance.update', 'S', {}],
  // Support tooling
  ['POST', '/support/impersonate', '/support/impersonate', 'support.configure', 'SU', {}],
  ['POST', '/support/impersonate/stop', '/support/impersonate/stop', 'support.configure', 'SU', {}],
  ['POST', '/support/account/recover', '/support/account/recover', 'support.update', 'SU', {}],
  ['POST', '/support/account/revoke-sessions', '/support/account/revoke-sessions', 'support.update', 'SU', {}],
  ['GET', '/support/tenants/:id/lookups', `/support/tenants/${NOID}/lookups`, 'support.view', 'SPUA'],
  ['POST', '/support/notifications/broadcast', '/support/notifications/broadcast', 'support.update', 'SU', {}],
  // Access requests
  ['GET', '/access-requests', '/access-requests', 'iam.access_requests.view', 'SPA'],
  ['POST', '/access-requests/:id/approve', `/access-requests/${NOID}/approve`, 'iam.access_requests.approve', 'SP', {}],
  ['POST', '/access-requests/:id/reject', `/access-requests/${NOID}/reject`, 'iam.access_requests.approve', 'SP', {}],
  // Plan catalogue
  ['GET', '/admin/plans', '/admin/plans', 'billing.plans.view', 'SPA'],
  ['GET', '/admin/plans/:id', `/admin/plans/${NOID}`, 'billing.plans.view', 'SPA'],
  ['POST', '/admin/plans', '/admin/plans', 'billing.plans.create', 'S', {}],
  ['PATCH', '/admin/plans/:id', `/admin/plans/${NOID}`, 'billing.plans.update', 'SP', {}],
  ['POST', '/admin/plans/:id/archive', `/admin/plans/${NOID}/archive`, 'billing.plans.archive', 'S', {}],
  ['POST', '/admin/plans/:id/disable', `/admin/plans/${NOID}/disable`, 'billing.plans.update', 'SP', {}],
  ['POST', '/admin/plans/:id/enable', `/admin/plans/${NOID}/enable`, 'billing.plans.update', 'SP', {}],
  ['POST', '/admin/plans/ensure-defaults', '/admin/plans/ensure-defaults', 'billing.plans.create', 'S', {}],
  // Subscriptions
  ['GET', '/admin/subscriptions', '/admin/subscriptions', 'billing.subscriptions.view', 'SPA'],
  ['GET', '/admin/subscriptions/:tenantId', `/admin/subscriptions/${NOID}`, 'billing.subscriptions.view', 'SPA'],
  ['GET', '/admin/subscriptions/:tenantId/timeline', `/admin/subscriptions/${NOID}/timeline`, 'billing.subscriptions.view', 'SPA'],
  ['POST', '/admin/subscriptions/:tenantId/change-plan', `/admin/subscriptions/${NOID}/change-plan`, 'billing.subscriptions.override', 'S', {}],
  ['POST', '/admin/subscriptions/:tenantId/set-state', `/admin/subscriptions/${NOID}/set-state`, 'billing.subscriptions.override', 'S', {}],
  ['POST', '/admin/subscriptions/:tenantId/checkout', `/admin/subscriptions/${NOID}/checkout`, 'billing.subscriptions.override', 'S', {}],
  ['GET', '/admin/subscriptions/:tenantId/transactions', `/admin/subscriptions/${NOID}/transactions`, 'billing.subscriptions.view', 'SPA'],
  ['GET', '/admin/subscriptions/:tenantId/webhooks', `/admin/subscriptions/${NOID}/webhooks`, 'billing.subscriptions.view', 'SPA'],
  ['POST', '/admin/subscriptions/reconcile', '/admin/subscriptions/reconcile?limit=0', 'billing.subscriptions.override', 'S', {}],
  // Entitlements
  ['GET', '/admin/entitlements/overrides', '/admin/entitlements/overrides', 'billing.entitlements.view', 'SPA'],
  ['GET', '/admin/entitlements/overrides/:tenantId', `/admin/entitlements/overrides/${NOID}`, 'billing.entitlements.view', 'SPA'],
  ['POST', '/admin/entitlements/overrides/:tenantId', `/admin/entitlements/overrides/${NOID}`, 'billing.entitlements.override', 'S', {}],
  ['POST', '/admin/entitlements/overrides/:id/revoke', `/admin/entitlements/overrides/${NOID}/revoke`, 'billing.entitlements.override', 'S', {}],
  ['GET', '/admin/entitlements/tenants/:tenantId', `/admin/entitlements/tenants/${NOID}`, 'billing.entitlements.view', 'SPA'],
  ['GET', '/admin/entitlements/usage/:tenantId', `/admin/entitlements/usage/${NOID}`, 'billing.entitlements.view', 'SPA'],
];

const ROLE_LETTERS = { super_admin: 'S', platform_admin: 'P', support_operator: 'U', auditor: 'A' };
const ROLE_ADMIN_TYPES = { super_admin: 'super', platform_admin: 'platform', support_operator: 'support', auditor: 'auditor' };

/** Statically list every platform-admin route as `METHOD /full/pattern`. */
function adminRoutesFromSource() {
  const index = readFileSync(path.join(ROOT, 'src/routes/index.js'), 'utf8');
  const importOf = new Map();
  for (const m of index.matchAll(/import\s+(\w+)\s+from\s+'\.\/([\w.-]+\.js)';/g)) importOf.set(m[1], m[2]);
  const mounts = [];
  for (const m of index.matchAll(/router\.use\('([^']+)',\s*(\w+)\)/g)) mounts.push({ prefix: m[1], file: importOf.get(m[2]) });

  const routes = new Set();
  for (const file of readdirSync(path.join(ROOT, 'src/routes'))) {
    // admin-auth is the allow-listed self-service surface (check-routes).
    if (!file.endsWith('.routes.js') || file === 'admin-auth.routes.js') continue;
    const cleaned = stripComments(readFileSync(path.join(ROOT, 'src/routes', file), 'utf8'));
    const routerAdmin = /router\.use\(\s*adminAuth\s*[,)]/.test(cleaned);
    for (const call of extractRouteCalls(cleaned)) {
      const admin = /\badminAuth\b/.test(call.args)
        || (routerAdmin && !/\b(?:authenticate|optionalAuthenticate|authenticateApiKey)\b/.test(call.args));
      if (!admin) continue;
      for (const mount of mounts.filter((x) => x.file === file)) {
        const full = `${mount.prefix}${call.path === '/' ? '' : call.path}`;
        routes.add(`${call.verb.toUpperCase()} ${full}`);
      }
    }
  }
  return routes;
}

let sessions = {};

before(async () => {
  await startMongo();
  await startHttp();
  await resetMongo();
  await rbacCache.clearAll();
  await seedPlatformRoles();
  for (const roleName of Object.keys(ROLE_LETTERS)) {
    sessions[roleName] = await adminSession({ adminType: ROLE_ADMIN_TYPES[roleName], roleName });
  }
});

after(async () => {
  sessions = {};
  await stopHttp();
  await stopMongo();
});

test('the matrix covers every platform-admin route', () => {
  const declared = adminRoutesFromSource();
  const covered = new Set(MATRIX.map(([method, pattern]) => `${method} ${pattern}`));
  const missing = [...declared].filter((route) => !covered.has(route));
  const stale = [...covered].filter((route) => !declared.has(route));
  assert.deepEqual(missing, [], 'every admin route needs a row in the role matrix');
  assert.deepEqual(stale, [], 'matrix rows must match a declared admin route');
  assert.ok(declared.size >= 100, `expected the full admin surface, found ${declared.size} routes`);
});

for (const roleName of Object.keys(ROLE_LETTERS)) {
  test(`permission matrix: ${roleName}`, async () => {
    const { auth } = sessions[roleName];
    const failures = [];
    for (const [method, , requestPath, key, allowed, body] of MATRIX) {
      const res = await api(`/api/v1${requestPath}`, {
        method,
        headers: auth,
        ...(body !== undefined ? { body } : {}),
      });
      const shouldAllow = allowed.includes(ROLE_LETTERS[roleName]);
      const deniedByPermission = res.status === 403 && res.json?.message === `You do not have the "${key}" permission`;
      // adminauth: a step-up refusal comes after the permission check passed
      // (step-up itself is covered by the admin-auth suites).
      const passedPermission = res.status === 403 && res.json?.code === 'STEP_UP_REQUIRED';
      if (shouldAllow) {
        if (!passedPermission && (res.status === 401 || res.status === 403 || res.status === 500)) {
          failures.push(`${method} ${requestPath}: expected allowed, got ${res.status} ${res.json?.message}`);
        }
      } else if (!deniedByPermission) {
        failures.push(`${method} ${requestPath}: expected 403 for missing ${key}, got ${res.status} ${res.json?.message}`);
      }
    }
    assert.deepEqual(failures, []);
  });
}

test('/admin-auth/me lists exactly the permissions each built-in role grants', async () => {
  for (const definition of PLATFORM_ROLES) {
    const me = await api('/api/v1/admin-auth/me', { headers: sessions[definition.name].auth });
    assert.equal(me.status, 200);
    assert.deepEqual(me.json.data.roles, [definition.name]);
    const expected = definition.allCatalogue ? [...PLATFORM_CATALOGUE_KEYS].sort() : [...definition.permissions].sort();
    assert.deepEqual(me.json.data.permissions, expected);
    assert.deepEqual(me.json.data.scope, { type: 'platform', tenantId: null });
  }
});

test('the auditor role is read-only and every built-in key exists in the catalogue', () => {
  const auditor = PLATFORM_ROLES.find((r) => r.name === 'auditor');
  assert.ok(auditor.permissions.length > 0);
  assert.ok(auditor.permissions.every(isReadOnlyKey), 'auditor holds only view/export keys');
  const catalogue = new Set(PLATFORM_CATALOGUE_KEYS);
  for (const role of PLATFORM_ROLES) {
    for (const key of role.permissions) assert.ok(catalogue.has(key), `${role.name}: ${key} is not in the catalogue`);
  }
  const support = PLATFORM_ROLES.find((r) => r.name === 'support_operator');
  const supportModules = new Set(support.permissions.map((k) => k.slice(0, k.lastIndexOf('.'))));
  assert.deepEqual([...supportModules].sort(), ['access_logs', 'audit_logs', 'compliance', 'iam.tenants', 'support']);
  assert.ok(support.permissions.filter((k) => !k.startsWith('support.')).every(isReadOnlyKey), 'support writes only through support tooling');
});

test('an auditor-type admin is refused writes even when a custom role grants them', async () => {
  const role = await roleService.create({ tenantId: null, name: 'auditor_with_write' });
  await roleService.addPermission({ roleId: String(role._id), permissionKey: 'iam.tenants.update', by: null });
  await roleService.addPermission({ roleId: String(role._id), permissionKey: 'iam.tenants.view', by: null });
  const auditor = await createAdmin({ adminType: 'auditor' });
  await adminService.assignRole({ adminId: String(auditor._id), roleId: String(role._id), by: null });
  const auth = await loginAdmin(auditor);

  const read = await api(`/api/v1/tenants/${NOID}`, { headers: auth });
  assert.equal(read.status, 404, 'reads still pass');
  const write = await api(`/api/v1/tenants/${NOID}`, { method: 'PATCH', headers: auth, body: { name: 'x' } });
  assert.equal(write.status, 403);
  assert.equal(write.json.message, 'Auditors have read-only access');

  // /admin-auth/me shows exactly what is enforced: the read key, not the write.
  const me = await api('/api/v1/admin-auth/me', { headers: auth });
  assert.deepEqual(me.json.data.permissions, ['iam.tenants.view']);
});
