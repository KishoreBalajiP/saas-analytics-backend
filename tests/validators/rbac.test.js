/**
 * Tests for the Sprint 2 RBAC validator schemas.
 *
 * Exercises the schema engine (`src/validators/index.js`) with the real
 * role, permission and admin CRUD schemas. No database - pure logic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../../src/validators/index.js';
import {
  createRoleSchema,
  updateRoleSchema,
  addPermissionSchema,
  removePermissionSchema,
  listSchema as roleListSchema,
} from '../../src/validators/role.validator.js';
import {
  createModuleSchema,
  createPermissionSchema,
  bulkCreateSchema,
  listSchema as permissionListSchema,
} from '../../src/validators/permission.validator.js';
import {
  createAdminSchema,
  invitationAcceptSchema,
  stepUpSchema,
  credentialResetSchema,
  loginSchema,
  mfaDisableSchema,
  updateAdminSchema,
  suspendSchema,
  restoreSchema,
  assignRoleSchema,
  revokeRoleSchema,
} from '../../src/validators/admin.validator.js';

const OID = '507f1f77bcf86cd799439011';
const BAD_OID = 'not-an-object-id';

/** Run the schema engine against req parts; returns `{ req, error }`. */
function run(schema, { body = {}, params = {}, query = {} } = {}) {
  const req = { body, params, query };
  let error = null;
  validate(schema)(req, {}, (err) => {
    error = err;
  });
  return { req, error };
}

// ---------------------------------------------------------------------------
// role validator
// ---------------------------------------------------------------------------

test('createRoleSchema accepts name + optional fields', () => {
  const { req, error } = run(createRoleSchema, { body: { name: 'analyst', description: 'Read only', tenantId: OID } });
  assert.equal(error, undefined);
  assert.equal(req.validated.body.name, 'analyst');
});

test('createRoleSchema rejects a missing name', () => {
  const { error } = run(createRoleSchema, { body: {} });
  assert.ok(error);
  assert.equal(error.statusCode, 422);
  assert.ok(error.errors.some((e) => e.field === 'name'));
});

test('updateRoleSchema requires a role id param', () => {
  assert.equal(run(updateRoleSchema, { params: { id: OID }, body: { name: 'x' } }).error, undefined);
  const bad = run(updateRoleSchema, { params: { id: BAD_OID }, body: { name: 'x' } });
  assert.ok(bad.error);
  assert.ok(bad.error.errors.some((e) => e.field === 'id'));
});

test('addPermissionSchema enforces the dotted permission key', () => {
  assert.equal(run(addPermissionSchema, { params: { id: OID }, body: { permissionKey: 'iam.admins.view' } }).error, undefined);
  const bad = run(addPermissionSchema, { params: { id: OID }, body: { permissionKey: 'view' } });
  assert.ok(bad.error);
  assert.ok(bad.error.errors.some((e) => e.field === 'permissionKey'));
});

test('removePermissionSchema mirrors addPermissionSchema', () => {
  assert.equal(run(removePermissionSchema, { params: { id: OID }, body: { permissionKey: 'iam.roles.manage' } }).error, undefined);
  assert.ok(run(removePermissionSchema, { params: { id: OID }, body: {} }).error);
});

test('role listSchema accepts pagination query params', () => {
  const { req, error } = run(roleListSchema, { query: { tenantId: OID, search: 'anal', page: '2', limit: '50' } });
  assert.equal(error, undefined);
  assert.equal(req.validated.query.page, 2);
  assert.equal(req.validated.query.limit, 50);
  assert.ok(run(roleListSchema, { query: { limit: '1000' } }).error);
});

// ---------------------------------------------------------------------------
// permission validator
// ---------------------------------------------------------------------------

test('createModuleSchema requires a dotted lowercase key', () => {
  assert.equal(run(createModuleSchema, { body: { key: 'iam', name: 'IAM' } }).error, undefined);
  assert.equal(run(createModuleSchema, { body: { key: 'iam.users', name: 'Users' } }).error, undefined);
  assert.ok(run(createModuleSchema, { body: { key: 'IAM', name: 'IAM' } }).error);
  assert.ok(run(createModuleSchema, { body: { key: 'iam', name: '' } }).error);
});

test('createPermissionSchema requires module + canonical action', () => {
  assert.equal(run(createPermissionSchema, { body: { module: 'iam', action: 'view' } }).error, undefined);
  const badAction = run(createPermissionSchema, { body: { module: 'iam', action: 'delete_everything' } });
  assert.ok(badAction.error);
  assert.ok(badAction.error.errors.some((e) => e.field === 'action'));
});

test('bulkCreateSchema validates each item', () => {
  const ok = run(bulkCreateSchema, {
    body: { items: [{ module: 'iam', action: 'view' }, { module: 'analytics', action: 'export' }] },
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.req.validated.body.items.length, 2);

  assert.ok(run(bulkCreateSchema, { body: { items: [] } }).error);
  const badItem = run(bulkCreateSchema, { body: { items: [{ module: 'iam', action: 'bogus' }] } });
  assert.ok(badItem.error);
});

test('permission listSchema accepts filter query params', () => {
  const { error } = run(permissionListSchema, { query: { module: 'iam', action: 'view', page: '1' } });
  assert.equal(error, undefined);
  assert.ok(run(permissionListSchema, { query: { action: 'nope' } }).error);
});

// ---------------------------------------------------------------------------
// admin validator
// ---------------------------------------------------------------------------

// adminauth (adm.09): admins are invited by email; the inviter never types
// a password, so `password` (and `status`) are dropped from the body.
test('createAdminSchema (invite) requires an email and drops any password', () => {
  const ok = run(createAdminSchema, { body: { email: 'a@b.com', password: 'longenough', status: 'active' } });
  assert.equal(ok.error, undefined);
  assert.equal(ok.req.validated.body.password, undefined, 'a typed password is never accepted');
  assert.equal(ok.req.validated.body.status, undefined, 'status is not chosen by the inviter');
  assert.ok(run(createAdminSchema, { body: {} }).error);
  assert.ok(run(createAdminSchema, { body: { email: 'not-an-email' } }).error);
  const badType = run(createAdminSchema, { body: { email: 'a@b.com', adminType: 'ceo' } });
  assert.ok(badType.error.errors.some((e) => e.field === 'adminType'));
});

test('adminauth schemas: invitation accept, step-up, credential reset, login recovery code', () => {
  const token = 'x'.repeat(43);
  assert.equal(run(invitationAcceptSchema, { body: { token, password: 'longenough' } }).error, undefined);
  assert.ok(run(invitationAcceptSchema, { body: { token, password: 'short' } }).error.errors.some((e) => e.field === 'password'));
  assert.ok(run(invitationAcceptSchema, { body: { token: 'short', password: 'longenough' } }).error);
  assert.equal(run(stepUpSchema, { body: { password: 'pw', code: '123456' } }).error, undefined);
  assert.ok(run(stepUpSchema, { body: { password: 'pw', code: '12345' } }).error);
  assert.ok(run(stepUpSchema, { body: { code: '123456' } }).error, 'password required');
  assert.equal(run(stepUpSchema, { body: { password: 'pw', recoveryCode: 'abcd-efgh-jkmn-pqrs' } }).error, undefined);
  assert.ok(run(stepUpSchema, { body: { password: 'pw', recoveryCode: '<script>alert(1)</script>' } }).error);
  assert.equal(run(credentialResetSchema, { params: { id: OID }, body: { reason: 'lost phone' } }).error, undefined);
  assert.ok(run(credentialResetSchema, { params: { id: OID }, body: {} }).error, 'reason required');
  assert.ok(run(credentialResetSchema, { params: { id: BAD_OID }, body: { reason: 'lost phone' } }).error);
  assert.equal(run(loginSchema, { body: { email: 'a@b.com', password: 'pw', recoveryCode: 'ABCD-EFGH-JKMN-PQRS' } }).error, undefined);
  assert.equal(run(mfaDisableSchema, { body: { password: 'pw', recoveryCode: 'ABCD-EFGH-JKMN-PQRS' } }).error, undefined);
});

test('updateAdminSchema requires an id param', () => {
  assert.equal(run(updateAdminSchema, { params: { id: OID }, body: { name: 'New' } }).error, undefined);
  assert.ok(run(updateAdminSchema, { params: {}, body: { name: 'New' } }).error);
});

test('suspend/restore schemas accept a reason and require the id', () => {
  assert.equal(run(suspendSchema, { params: { id: OID }, body: { reason: 'policy' } }).error, undefined);
  assert.equal(run(restoreSchema, { params: { id: OID } }).error, undefined);
  assert.ok(run(suspendSchema, { params: {} }).error);
});

test('assignRoleSchema requires roleId and accepts a future expiresAt', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(run(assignRoleSchema, { params: { id: OID }, body: { roleId: OID } }).error, undefined);
  assert.equal(run(assignRoleSchema, { params: { id: OID }, body: { roleId: OID, expiresAt: future } }).error, undefined);
  assert.ok(run(assignRoleSchema, { params: { id: OID }, body: {} }).error);
  assert.ok(run(assignRoleSchema, { params: { id: OID }, body: { roleId: BAD_OID } }).error);
});

test('revokeRoleSchema requires id and roleId params', () => {
  assert.equal(run(revokeRoleSchema, { params: { id: OID, roleId: OID } }).error, undefined);
  assert.ok(run(revokeRoleSchema, { params: { id: OID } }).error);
});
