/**
 * Tests for the Sprint 2 RBAC middleware.
 *
 * Covers the fine-grained `permission` / `denyIf`, the coarse-grained
 * `modulePermission` / `requireRole` / `requireAdminType`, the multi-tenant
 * `tenantIsolation` guard, the `audit` observer, and the newly wired
 * `authorize()` in `auth.middleware.js`. Service calls are mocked so no
 * database is needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';

import { permission, denyIf } from '../../src/middleware/permission.middleware.js';
import { modulePermission } from '../../src/middleware/modulePermission.middleware.js';
import { requireRole, requireAdminType } from '../../src/middleware/rbac.middleware.js';
import { tenantIsolation, tenantIsolationForJob } from '../../src/middleware/tenantIsolation.middleware.js';
import { audit } from '../../src/middleware/audit.middleware.js';
import { authorize } from '../../src/middleware/auth.middleware.js';

import permissionService from '../../src/services/permission.service.js';
import roleService from '../../src/services/role.service.js';
import adminRepository from '../../src/repositories/admin.repository.js';
import auditLogService from '../../src/services/auditLog.service.js';

/** Invoke a middleware; returns the error passed to `next` (or undefined). */
async function invoke(middleware, req, res = {}) {
  let error;
  await middleware(req, res, (err) => {
    error = err;
  });
  return error;
}

/** Fake Express response that can be observed on `finish`. */
function fakeRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.setHeader = () => {};
  return res;
}

function stubPerms(t, keys) {
  mock.method(permissionService, 'resolveActorPermissions', async () => keys);
  t.after(() => mock.restoreAll());
}

function stubRoles(t, names) {
  mock.method(roleService, 'resolveActorRoles', async () => names);
  t.after(() => mock.restoreAll());
}

const USER = { id: 'usr_1', type: 'user', tenantId: 'ten_1', email: 'u@t.com' };

// ---------------------------------------------------------------------------
// permission / denyIf
// ---------------------------------------------------------------------------

test('permission allows when the actor holds the declared key', async (t) => {
  stubPerms(t, ['iam.admins.view', 'iam.roles.manage']);
  const req = { admin: USER };
  const error = await invoke(permission('iam.admins', 'view'), req);
  assert.equal(error, undefined);
});

test('permission refuses 403 when the actor lacks the declared key', async (t) => {
  stubPerms(t, ['iam.admins.view']);
  const req = { admin: USER };
  const error = await invoke(permission('iam.admins', 'manage'), req);
  assert.equal(error.statusCode, 403);
});

test('permission refuses 403 without any authenticated identity', async () => {
  const req = {};
  const error = await invoke(permission('iam.admins', 'view'), req);
  assert.equal(error.statusCode, 403);
});

test('permission supports dynamic (module, action) functions', async (t) => {
  stubPerms(t, ['tenants.view']);
  const req = { admin: USER, params: { tenantId: 'ten_2' } };
  const error = await invoke(permission((r) => ['tenants', 'view']), req);
  assert.equal(error, undefined);
});

test('permission refuses 403 when the route declares no key', async (t) => {
  stubPerms(t, []);
  const req = { admin: USER };
  const error = await invoke(permission(null, null), req);
  assert.equal(error.statusCode, 403);
});

test('denyIf refuses 403 when the actor DOES hold the declared key', async (t) => {
  stubPerms(t, ['iam.admins.suspend']);
  const req = { admin: USER };
  const error = await invoke(denyIf('iam.admins', 'suspend'), req);
  assert.equal(error.statusCode, 403);
});

test('denyIf passes when the actor does not hold the declared key', async (t) => {
  stubPerms(t, ['iam.admins.view']);
  const req = { admin: USER };
  const error = await invoke(denyIf('iam.admins', 'suspend'), req);
  assert.equal(error, undefined);
});

// ---------------------------------------------------------------------------
// modulePermission
// ---------------------------------------------------------------------------

test('modulePermission allows when the actor holds any permission on the module', async (t) => {
  stubPerms(t, ['platform.billing.view', 'platform.billing.manage']);
  const req = { admin: USER };
  const error = await invoke(modulePermission('platform'), req);
  assert.equal(error, undefined);
});

test('modulePermission refuses 403 when the actor has no permission on the module', async (t) => {
  stubPerms(t, ['iam.admins.view']);
  const req = { admin: USER };
  const error = await invoke(modulePermission('platform'), req);
  assert.equal(error.statusCode, 403);
});

test('modulePermission refuses 403 without an identity', async () => {
  const error = await invoke(modulePermission('platform'), {});
  assert.equal(error.statusCode, 403);
});

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------

test('requireRole passes when the actor holds one of the allowed roles', async (t) => {
  stubRoles(t, ['owner', 'admin']);
  const req = { user: USER };
  const error = await invoke(requireRole('analyst', 'admin'), req);
  assert.equal(error, undefined);
});

test('requireRole refuses 403 when none of the allowed roles match', async (t) => {
  stubRoles(t, ['owner']);
  const req = { user: USER };
  const error = await invoke(requireRole('admin'), req);
  assert.equal(error.statusCode, 403);
});

test('requireRole with no arguments passes for any assigned role', async (t) => {
  stubRoles(t, ['member']);
  const req = { user: USER };
  const error = await invoke(requireRole(), req);
  assert.equal(error, undefined);
});

test('requireRole refuses 403 when the actor has no roles', async (t) => {
  stubRoles(t, []);
  const req = { user: USER };
  const error = await invoke(requireRole(), req);
  assert.equal(error.statusCode, 403);
});

test('requireRole refuses 403 without an identity', async () => {
  const error = await invoke(requireRole(), {});
  assert.equal(error.statusCode, 403);
});

// ---------------------------------------------------------------------------
// requireAdminType
// ---------------------------------------------------------------------------

test('requireAdminType passes for a matching admin type', async (t) => {
  mock.method(adminRepository, 'findById', async () => ({ _id: 'adm_1', adminType: 'super' }));
  t.after(() => mock.restoreAll());
  const req = { admin: USER };
  const error = await invoke(requireAdminType('super', 'platform'), req);
  assert.equal(error, undefined);
});

test('requireAdminType refuses 403 for a non-matching admin type', async (t) => {
  mock.method(adminRepository, 'findById', async () => ({ _id: 'adm_1', adminType: 'support' }));
  t.after(() => mock.restoreAll());
  const req = { admin: USER };
  const error = await invoke(requireAdminType('super'), req);
  assert.equal(error.statusCode, 403);
});

test('requireAdminType refuses 403 for a non-admin identity', async () => {
  const req = { user: USER };
  const error = await invoke(requireAdminType('super'), req);
  assert.equal(error.statusCode, 403);
});

test('requireAdminType refuses 403 when the admin row is missing', async (t) => {
  mock.method(adminRepository, 'findById', async () => null);
  t.after(() => mock.restoreAll());
  const req = { admin: USER };
  const error = await invoke(requireAdminType('super'), req);
  assert.equal(error.statusCode, 403);
});

// ---------------------------------------------------------------------------
// tenantIsolation
// ---------------------------------------------------------------------------

test('tenantIsolation passes for a user hitting their own tenant', async () => {
  const req = { user: USER, params: { tenantId: 'ten_1' } };
  const error = await invoke(tenantIsolation(), req);
  assert.equal(error, undefined);
});

test('tenantIsolation refuses 403 for a user hitting another tenant', async () => {
  const req = { user: USER, params: { tenantId: 'ten_2' } };
  const error = await invoke(tenantIsolation(), req);
  assert.equal(error.statusCode, 403);
});

test('tenantIsolation passes for an admin with wildcard tenantScope', async () => {
  const req = { admin: { ...USER, tenantId: '*' }, params: { tenantId: 'ten_9' } };
  const error = await invoke(tenantIsolation(), req);
  assert.equal(error, undefined);
});

test('tenantIsolation passes for an admin scoped to the requested tenant', async () => {
  const req = { admin: { ...USER, tenantId: 'ten_3' }, body: { tenantId: 'ten_3' } };
  const error = await invoke(tenantIsolation(), req);
  assert.equal(error, undefined);
});

test('tenantIsolation refuses 403 for an admin scoped elsewhere', async () => {
  const req = { admin: { ...USER, tenantId: 'ten_3' }, params: { tenantId: 'ten_4' } };
  const error = await invoke(tenantIsolation(), req);
  assert.equal(error.statusCode, 403);
});

test('tenantIsolation passes through when no tenant is requested', async () => {
  const req = { admin: USER };
  const error = await invoke(tenantIsolation(), req);
  assert.equal(error, undefined);
});

test('tenantIsolation refuses 403 without an identity', async () => {
  const req = { params: { tenantId: 'ten_1' } };
  const error = await invoke(tenantIsolation(), req);
  assert.equal(error.statusCode, 403);
});

test('tenantIsolationForJob passes on a matching scope and throws on mismatch', () => {
  const guard = tenantIsolationForJob({ tenantId: 'ten_1' });
  assert.doesNotThrow(() => guard({ tenantId: 'ten_1' }));
  assert.throws(() => guard({ tenantId: 'ten_2' }), (err) => err.statusCode === 403);
  assert.throws(() => guard({}), (err) => err.statusCode === 403);
});

test('tenantIsolationForJob with wildcard passes for any scope', () => {
  const guard = tenantIsolationForJob({ tenantId: '*' });
  assert.doesNotThrow(() => guard({ tenantId: 'ten_5' }));
  assert.doesNotThrow(() => guard({ tenantId: null }));
});

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

test('audit emits a success event after the response finishes', async (t) => {
  const calls = [];
  mock.method(auditLogService, 'emit', async (event) => calls.push(event));
  t.after(() => mock.restoreAll());

  const req = {
    admin: USER,
    body: { reason: 'annual review' },
    headers: { 'user-agent': 'test-agent' },
    ip: '127.0.0.1',
    id: 'req_1',
  };
  const res = fakeRes(200);
  const error = await invoke(audit('iam.admins', 'suspend'), req, res);
  assert.equal(error, undefined);
  assert.equal(calls.length, 0); // not yet finished

  res.emit('finish');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].module, 'iam.admins');
  assert.equal(calls[0].action, 'suspend');
  assert.equal(calls[0].result, 'success');
  assert.equal(calls[0].reason, 'annual review');
  assert.equal(calls[0].actor.type, 'admin');
  assert.equal(calls[0].requestId, 'req_1');
});

test('audit records a failure result for 4xx responses', async (t) => {
  const calls = [];
  mock.method(auditLogService, 'emit', async (event) => calls.push(event));
  t.after(() => mock.restoreAll());

  const req = { user: USER, body: {}, headers: {}, id: 'req_2' };
  const res = fakeRes(403);
  await invoke(audit('iam.roles', 'manage'), req, res);
  res.emit('finish');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].result, 'failure');
  assert.equal(calls[0].errorCode, '403');
  assert.equal(calls[0].actor.type, 'user');
});

test('audit degrades to a system actor without an identity', async (t) => {
  const calls = [];
  mock.method(auditLogService, 'emit', async (event) => calls.push(event));
  t.after(() => mock.restoreAll());

  const req = { body: {}, headers: {}, id: 'req_3' };
  const res = fakeRes(200);
  await invoke(audit('iam.tenants', 'create'), req, res);
  res.emit('finish');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor.type, 'system');
  assert.equal(calls[0].actor.id, null);
});

test('audit swallows a failing emit without affecting the request', async (t) => {
  mock.method(auditLogService, 'emit', async () => {
    throw new Error('db down');
  });
  t.after(() => mock.restoreAll());

  const req = { admin: USER, body: {}, headers: {} };
  const res = fakeRes(200);
  const error = await invoke(audit('iam.admins', 'create'), req, res);
  assert.equal(error, undefined);
  res.emit('finish');
});

// ---------------------------------------------------------------------------
// authorize() (auth.middleware.js, now wired to the RBAC role set)
// ---------------------------------------------------------------------------

test('authorize passes when the resolved roles include an allowed role', async (t) => {
  stubRoles(t, ['owner']);
  const req = { user: USER };
  const error = await invoke(authorize('owner', 'admin'), req);
  assert.equal(error, undefined);
});

test('authorize refuses 403 when no allowed role matches', async (t) => {
  stubRoles(t, ['analyst']);
  const req = { user: USER };
  const error = await invoke(authorize('owner'), req);
  assert.equal(error.statusCode, 403);
});

test('authorize refuses 403 for an identity with no roles', async (t) => {
  stubRoles(t, []);
  const req = { user: USER };
  const error = await invoke(authorize('owner'), req);
  assert.equal(error.statusCode, 403);
});

test('authorize refuses 403 without an identity', async () => {
  const error = await invoke(authorize('owner'), {});
  assert.equal(error.statusCode, 403);
});
