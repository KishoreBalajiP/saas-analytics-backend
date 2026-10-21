/**
 * Members package (roadmap 2.10; ten.05, ten.07): tenant member and role
 * management through the real HTTP app.
 *
 * Covers: member listing (names-only for viewers), role changes within the
 * ceiling, no self-modification, the last-owner rule, deactivation cutting
 * off an existing access token, member removal (seat released, email can
 * be invited again), cross-tenant refusal, custom roles within the ceiling,
 * and ownership transfer (password step-up, atomic swap, audited).
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import * as emailService from '../../src/services/email.service.js';
import userService from '../../src/services/user.service.js';
import tenantMemberService from '../../src/services/tenantMember.service.js';
import invitationService from '../../src/services/tenantInvitation.service.js';
import tenantRepository from '../../src/repositories/tenant.repository.js';
import { User } from '../../src/models/User.js';
import { Role } from '../../src/models/Role.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { Session } from '../../src/models/Session.js';
import {
  PASSWORD, createWorkspace, addMember, signIn, roleId, roleNamesOf, seatCount,
} from './helpers.js';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); });
after(async () => { await emailService.close(); await stopHttp(); await stopMongo(); });

async function setup() {
  const ws = await createWorkspace();
  const admin = await addMember({ tenantId: ws.tenantId, roleName: 'Admin', name: 'Adam Admin' });
  const viewer = await addMember({ tenantId: ws.tenantId, roleName: 'Viewer', name: 'Vera Viewer' });
  const auth = {
    owner: await signIn(ws.tenant, ws.ownerEmail),
    admin: await signIn(ws.tenant, admin.email),
    viewer: await signIn(ws.tenant, viewer.email),
  };
  return { ...ws, admin, viewer, auth };
}

/* -------------------------------- listing -------------------------------- */

test('members list shows roles and status; viewers see names only', async () => {
  const ws = await setup();
  const asOwner = await api('/api/v1/workspace/members', { headers: ws.auth.owner });
  assert.equal(asOwner.status, 200);
  assert.equal(asOwner.json.data.length, 3);
  const owner = asOwner.json.data.find((m) => m.isPrimaryOwner);
  assert.ok(owner);
  assert.equal(owner.isOwner, true);
  assert.deepEqual(owner.roles.map((r) => r.name), ['Owner']);
  assert.equal(owner.email, ws.ownerEmail);
  assert.equal(owner.passwordHash, undefined);
  assert.equal(asOwner.json.meta.total, 3);

  const asViewer = await api('/api/v1/workspace/members', { headers: ws.auth.viewer });
  assert.equal(asViewer.status, 200);
  assert.ok(asViewer.json.data.every((m) => m.email === null), 'viewers do not see contact details');
  assert.ok(asViewer.json.data.some((m) => m.name === 'Adam Admin'));

  const unauthenticated = await api('/api/v1/workspace/members');
  assert.equal(unauthenticated.status, 401);
});

/* ------------------------------ role changes ----------------------------- */

test('role changes respect the ceiling and are audited', async () => {
  const ws = await setup();
  const managerId = await roleId(ws.tenantId, 'Manager');
  const adminRoleId = await roleId(ws.tenantId, 'Admin');
  const ownerRoleId = await roleId(ws.tenantId, 'Owner');

  // Owner: Viewer -> Manager.
  const changed = await api(`/api/v1/workspace/members/${ws.viewer._id}/roles`, {
    method: 'PUT', headers: ws.auth.owner, body: { roleIds: [managerId] },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.deepEqual(changed.json.data.roles.map((r) => r.name), ['Manager']);
  assert.deepEqual(await roleNamesOf(ws.tenantId, ws.viewer._id), ['Manager']);
  const audit = await AuditLog.findOne({ action: 'member.roles_changed', tenantId: ws.tenantId }).lean();
  assert.ok(audit, 'role change audited');
  assert.deepEqual(audit.after.roles, ['Manager']);

  // Admin may assign roles strictly below Admin...
  const toViewer = await api(`/api/v1/workspace/members/${ws.viewer._id}/roles`, {
    method: 'PUT', headers: ws.auth.admin, body: { roleIds: [await roleId(ws.tenantId, 'Viewer')] },
  });
  assert.equal(toViewer.status, 200, JSON.stringify(toViewer.json));

  // ...but not Admin itself, nor Owner.
  const toAdmin = await api(`/api/v1/workspace/members/${ws.viewer._id}/roles`, {
    method: 'PUT', headers: ws.auth.admin, body: { roleIds: [adminRoleId] },
  });
  assert.equal(toAdmin.status, 403);
  assert.equal(toAdmin.json.code, 'ROLE_CEILING');
  const toOwner = await api(`/api/v1/workspace/members/${ws.viewer._id}/roles`, {
    method: 'PUT', headers: ws.auth.admin, body: { roleIds: [ownerRoleId] },
  });
  assert.equal(toOwner.status, 403);

  // An Admin cannot touch the Owner.
  const demoteOwner = await api(`/api/v1/workspace/members/${ws.owner._id}/roles`, {
    method: 'PUT', headers: ws.auth.admin, body: { roleIds: [managerId] },
  });
  assert.equal(demoteOwner.status, 403);
  assert.equal(demoteOwner.json.code, 'ROLE_CEILING');
  assert.deepEqual(await roleNamesOf(ws.tenantId, ws.owner._id), ['Owner']);

  // A Viewer has no roles.assign at all.
  const byViewer = await api(`/api/v1/workspace/members/${ws.admin._id}/roles`, {
    method: 'PUT', headers: ws.auth.viewer, body: { roleIds: [managerId] },
  });
  assert.equal(byViewer.status, 403);

  // Nobody changes their own roles.
  const self = await api(`/api/v1/workspace/members/${ws.owner._id}/roles`, {
    method: 'PUT', headers: ws.auth.owner, body: { roleIds: [managerId] },
  });
  assert.equal(self.status, 403);
  assert.deepEqual(await roleNamesOf(ws.tenantId, ws.owner._id), ['Owner']);

  // Invalid input.
  const empty = await api(`/api/v1/workspace/members/${ws.viewer._id}/roles`, {
    method: 'PUT', headers: ws.auth.owner, body: { roleIds: [] },
  });
  assert.equal(empty.status, 422);
});

test('a role change takes effect on the member\'s next request', async () => {
  const ws = await setup();
  const before = await api('/api/v1/workspace/invitations', { headers: ws.auth.viewer });
  assert.equal(before.status, 403, 'a Viewer cannot list invitations');
  const promoted = await api(`/api/v1/workspace/members/${ws.viewer._id}/roles`, {
    method: 'PUT', headers: ws.auth.owner, body: { roleIds: [await roleId(ws.tenantId, 'Admin')] },
  });
  assert.equal(promoted.status, 200);
  const afterPromotion = await api('/api/v1/workspace/invitations', { headers: ws.auth.viewer });
  assert.equal(afterPromotion.status, 200, 'the same access token now carries the new role');
});

test('the last active Owner cannot be demoted, deactivated or removed', async () => {
  const ws = await setup();
  // Through the API an Owner can never manage themselves (self rule) ...
  const selfDeactivate = await api(`/api/v1/workspace/members/${ws.owner._id}/deactivate`, {
    method: 'POST', headers: ws.auth.owner, body: {},
  });
  assert.equal(selfDeactivate.status, 403);
  // ... and system callers (SSO/SCIM deprovisioning) hit the last-owner rule.
  await assert.rejects(
    () => userService.deactivateMember({ tenantId: ws.tenantId, userId: String(ws.owner._id), by: 'scim', actorType: 'system' }),
    (err) => err.statusCode === 409 && err.code === 'LAST_OWNER',
  );

  // With a second Owner, one Owner can demote the other; the survivor
  // keeps ownership and `ownerId` follows the remaining Owner.
  const ownerRoleId = await roleId(ws.tenantId, 'Owner');
  const promote = await api(`/api/v1/workspace/members/${ws.admin._id}/roles`, {
    method: 'PUT', headers: ws.auth.owner, body: { roleIds: [ownerRoleId] },
  });
  assert.equal(promote.status, 200);
  const coOwner = await signIn(ws.tenant, ws.admin.email);
  const demoteFirst = await api(`/api/v1/workspace/members/${ws.owner._id}/roles`, {
    method: 'PUT', headers: coOwner, body: { roleIds: [await roleId(ws.tenantId, 'Admin')] },
  });
  assert.equal(demoteFirst.status, 200, JSON.stringify(demoteFirst.json));
  const tenant = await tenantRepository.findById(ws.tenantId);
  assert.equal(String(tenant.ownerId), String(ws.admin._id), 'ownerId moved to the remaining Owner');
  await assert.rejects(
    () => userService.deactivateMember({ tenantId: ws.tenantId, userId: String(ws.admin._id), by: 'scim', actorType: 'system' }),
    (err) => err.code === 'LAST_OWNER',
  );
});

/* ------------------------------- deactivate ------------------------------ */

test('deactivation cuts off an existing access token; reactivation restores sign-in', async () => {
  const ws = await setup();
  const me = await api('/api/v1/users/me', { headers: ws.auth.viewer });
  assert.equal(me.status, 200);

  const off = await api(`/api/v1/workspace/members/${ws.viewer._id}/deactivate`, {
    method: 'POST', headers: ws.auth.owner, body: { reason: 'left the company' },
  });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal(off.json.data.member.status, 'suspended');
  assert.ok(off.json.data.sessionsRevoked >= 1);

  const cutOff = await api('/api/v1/users/me', { headers: ws.auth.viewer });
  assert.equal(cutOff.status, 401, 'the access token stops working on the next request');
  const relogin = await api('/api/v1/auth/login', {
    method: 'POST', headers: { 'X-Tenant-Id': ws.tenant.slug }, body: { email: ws.viewer.email, password: PASSWORD },
  });
  assert.notEqual(relogin.status, 200);
  assert.ok(await AuditLog.findOne({ action: 'member.deactivated', tenantId: ws.tenantId }).lean());

  // An Admin cannot deactivate the Owner; a Viewer cannot deactivate anyone.
  const adminOnOwner = await api(`/api/v1/workspace/members/${ws.owner._id}/deactivate`, {
    method: 'POST', headers: ws.auth.admin, body: {},
  });
  assert.equal(adminOnOwner.status, 403);

  const on = await api(`/api/v1/workspace/members/${ws.viewer._id}/reactivate`, {
    method: 'POST', headers: ws.auth.admin, body: {},
  });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(on.json.data.member.status, 'active');
  await signIn(ws.tenant, ws.viewer.email);
});

/* --------------------------------- remove -------------------------------- */

test('removing a member drops access, frees the seat and lets the email be invited again', async () => {
  const ws = await setup();
  const seatsBefore = await seatCount(ws.tenantId);
  const removed = await api(`/api/v1/workspace/members/${ws.viewer._id}`, { method: 'DELETE', headers: ws.auth.owner });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.equal(await seatCount(ws.tenantId), Math.max(0, seatsBefore - 1));
  const raw = await User.collection.findOne({ _id: ws.viewer._id });
  assert.ok(raw.deletedAt, 'account soft-deleted');
  assert.deepEqual(await roleNamesOf(ws.tenantId, ws.viewer._id), []);
  assert.equal(await Session.countDocuments({ actorId: String(ws.viewer._id), status: 'active' }), 0);
  const cutOff = await api('/api/v1/users/me', { headers: ws.auth.viewer });
  assert.equal(cutOff.status, 401);

  // db.07: the same address can be invited again.
  const sink = [];
  emailService.captureInto(sink);
  const invite = await api('/api/v1/invitations', {
    method: 'POST', headers: ws.auth.owner, body: { email: ws.viewer.email, roleName: 'Viewer' },
  });
  emailService.stopCapture();
  assert.equal(invite.status, 201, JSON.stringify(invite.json));
  const token = new URL(sink[0].text.match(/https?:\/\/[^\s]+/u)[0]).searchParams.get('token');
  await invitationService.accept({ token, name: 'Back Again', password: PASSWORD });
  await signIn(ws.tenant, ws.viewer.email);

  // An Admin cannot remove the Owner, and nobody removes themselves.
  const adminOnOwner = await api(`/api/v1/workspace/members/${ws.owner._id}`, { method: 'DELETE', headers: ws.auth.admin });
  assert.equal(adminOnOwner.status, 403);
  const self = await api(`/api/v1/workspace/members/${ws.owner._id}`, { method: 'DELETE', headers: ws.auth.owner });
  assert.equal(self.status, 403);
});

/* ------------------------------ cross-tenant ----------------------------- */

test('member management across tenants is refused', async () => {
  const a = await setup();
  const b = await createWorkspace('Other');
  const stranger = await addMember({ tenantId: b.tenantId, roleName: 'Viewer' });
  const bViewerRole = await roleId(b.tenantId, 'Viewer');

  for (const [method, path, body] of [
    ['GET', `/api/v1/workspace/members/${stranger._id}`],
    ['PUT', `/api/v1/workspace/members/${stranger._id}/roles`, { roleIds: [await roleId(a.tenantId, 'Viewer')] }],
    ['POST', `/api/v1/workspace/members/${stranger._id}/deactivate`, {}],
    ['POST', `/api/v1/workspace/members/${stranger._id}/reactivate`, {}],
    ['DELETE', `/api/v1/workspace/members/${stranger._id}`],
  ]) {
    const res = await api(path, { method, headers: a.auth.owner, body });
    assert.equal(res.status, 404, `${method} ${path} -> ${res.status}`);
  }
  // Another tenant's role id cannot be granted.
  const foreignRole = await api(`/api/v1/workspace/members/${a.viewer._id}/roles`, {
    method: 'PUT', headers: a.auth.owner, body: { roleIds: [bViewerRole] },
  });
  assert.equal(foreignRole.status, 422);
  // A forged tenant header is refused before any handler runs.
  const forged = await api('/api/v1/workspace/members', { headers: { ...a.auth.owner, 'X-Tenant-Id': b.tenantId } });
  assert.equal(forged.status, 403);
  const stillActive = await User.findById(stranger._id).lean();
  assert.equal(stillActive.status, 'active');
  // Listing only ever shows the caller's tenant.
  const list = await api('/api/v1/workspace/members', { headers: a.auth.owner });
  assert.ok(list.json.data.every((m) => m.id !== String(stranger._id)));
});

/* ------------------------------ custom roles ----------------------------- */

test('custom roles: created and edited within the ceiling, deleted only when unassigned, name reusable', async () => {
  const ws = await setup();
  const roles = await api('/api/v1/workspace/roles', { headers: ws.auth.owner });
  assert.equal(roles.status, 200);
  assert.deepEqual(roles.json.data.slice(0, 4).map((r) => r.name), ['Owner', 'Admin', 'Manager', 'Viewer']);
  assert.ok(roles.json.data.every((r) => r.editable === false));
  const ownerView = roles.json.data.find((r) => r.name === 'Owner');
  assert.ok(ownerView.permissions.includes('workspace.delete'));
  assert.equal(ownerView.memberCount, 1);

  const catalogue = await api('/api/v1/workspace/roles/permissions', { headers: ws.auth.owner });
  assert.equal(catalogue.status, 200);
  assert.equal(catalogue.json.data.find((p) => p.key === 'workspace.delete').assignable, false);
  assert.equal(catalogue.json.data.find((p) => p.key === 'dashboards.view').assignable, true);

  const created = await api('/api/v1/workspace/roles', {
    method: 'POST', headers: ws.auth.owner,
    body: { name: 'Developer', description: 'API and embed', permissions: ['api_keys.view', 'api_keys.create', 'dashboards.view'] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.editable, true);
  const devId = created.json.data.id;

  const ownerOnly = await api('/api/v1/workspace/roles', {
    method: 'POST', headers: ws.auth.owner, body: { name: 'Shadow owner', permissions: ['workspace.delete'] },
  });
  assert.equal(ownerOnly.status, 422);
  const unknown = await api('/api/v1/workspace/roles', {
    method: 'POST', headers: ws.auth.owner, body: { name: 'Odd', permissions: ['iam.admins.create'] },
  });
  assert.equal(unknown.status, 422);
  const builtIn = await api('/api/v1/workspace/roles', {
    method: 'POST', headers: ws.auth.owner, body: { name: 'viewer', permissions: ['dashboards.view'] },
  });
  assert.equal(builtIn.status, 422);
  const byAdmin = await api('/api/v1/workspace/roles', {
    method: 'POST', headers: ws.auth.admin, body: { name: 'Nope', permissions: ['dashboards.view'] },
  });
  assert.equal(byAdmin.status, 403, 'Admins do not hold roles.create');
  const editDefault = await api(`/api/v1/workspace/roles/${await roleId(ws.tenantId, 'Viewer')}`, {
    method: 'PATCH', headers: ws.auth.owner, body: { permissions: ['dashboards.view'] },
  });
  assert.equal(editDefault.status, 409);

  const edited = await api(`/api/v1/workspace/roles/${devId}`, {
    method: 'PATCH', headers: ws.auth.owner, body: { permissions: ['api_keys.view', 'embed.view'] },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.deepEqual(edited.json.data.permissions, ['api_keys.view', 'embed.view']);

  // Assigned roles cannot be deleted.
  const assign = await api(`/api/v1/workspace/members/${ws.viewer._id}/roles`, {
    method: 'PUT', headers: ws.auth.owner, body: { roleIds: [devId] },
  });
  assert.equal(assign.status, 200);
  const blocked = await api(`/api/v1/workspace/roles/${devId}`, { method: 'DELETE', headers: ws.auth.owner });
  assert.equal(blocked.status, 409);
  await api(`/api/v1/workspace/members/${ws.viewer._id}/roles`, {
    method: 'PUT', headers: ws.auth.owner, body: { roleIds: [await roleId(ws.tenantId, 'Viewer')] },
  });
  const deleted = await api(`/api/v1/workspace/roles/${devId}`, { method: 'DELETE', headers: ws.auth.owner });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  assert.ok((await Role.collection.findOne({ _id: (await Role.collection.findOne({ name: 'Developer' }))._id })).deletedAt);

  // db.07: a deleted role's name can be used again.
  const again = await api('/api/v1/workspace/roles', {
    method: 'POST', headers: ws.auth.owner, body: { name: 'Developer', permissions: ['dashboards.view'] },
  });
  assert.equal(again.status, 201, JSON.stringify(again.json));

  // Another tenant's role is not visible.
  const other = await createWorkspace('Other');
  const otherOwner = await signIn(other.tenant, other.ownerEmail);
  const peek = await api(`/api/v1/workspace/roles/${again.json.data.id}`, { headers: otherOwner });
  assert.equal(peek.status, 404);
});

/* ---------------------------- ownership transfer --------------------------- */

test('ownership transfer needs the password, targets an active member and swaps Owner atomically', async () => {
  const ws = await setup();
  const wrongPassword = await api('/api/v1/workspace/ownership/transfer', {
    method: 'POST', headers: ws.auth.owner, body: { userId: String(ws.admin._id), password: 'not-the-password' },
  });
  assert.equal(wrongPassword.status, 403);
  assert.equal(wrongPassword.json.code, 'STEP_UP_FAILED');

  const byAdmin = await api('/api/v1/workspace/ownership/transfer', {
    method: 'POST', headers: ws.auth.admin, body: { userId: String(ws.viewer._id), password: PASSWORD },
  });
  assert.equal(byAdmin.status, 403, 'only Owners hold workspace.transfer');

  await userService.deactivateMember({ tenantId: ws.tenantId, userId: String(ws.viewer._id), by: 'test', actorType: 'system' });
  const toInactive = await api('/api/v1/workspace/ownership/transfer', {
    method: 'POST', headers: ws.auth.owner, body: { userId: String(ws.viewer._id), password: PASSWORD },
  });
  assert.equal(toInactive.status, 409);

  const done = await api('/api/v1/workspace/ownership/transfer', {
    method: 'POST', headers: ws.auth.owner, body: { userId: String(ws.admin._id), password: PASSWORD },
  });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.data.ownerId, String(ws.admin._id));
  assert.deepEqual(await roleNamesOf(ws.tenantId, ws.admin._id), ['Admin', 'Owner']);
  assert.deepEqual(await roleNamesOf(ws.tenantId, ws.owner._id), ['Admin'], 'previous owner downgraded to Admin');
  const tenant = await tenantRepository.findById(ws.tenantId);
  assert.equal(String(tenant.ownerId), String(ws.admin._id));
  const audit = await AuditLog.findOne({ action: 'tenant.owner_changed', tenantId: ws.tenantId }).lean();
  assert.ok(audit);
  assert.equal(audit.after.previousOwnerDemotedTo, 'Admin');
  assert.ok(await AuditLog.findOne({ action: 'tenant.ownership.transferred', tenantId: ws.tenantId }).lean(), 'security event recorded');

  // The previous owner lost Owner-only powers on the very next request.
  const oldOwnerAgain = await api('/api/v1/workspace/ownership/transfer', {
    method: 'POST', headers: ws.auth.owner, body: { userId: String(ws.owner._id), password: PASSWORD },
  });
  assert.equal(oldOwnerAgain.status, 403);
});

test('concurrent ownership transfers leave exactly one new Owner', async () => {
  const ws = await setup();
  const second = await addMember({ tenantId: ws.tenantId, roleName: 'Manager' });
  const results = await Promise.all([
    api('/api/v1/workspace/ownership/transfer', {
      method: 'POST', headers: ws.auth.owner, body: { userId: String(ws.admin._id), password: PASSWORD },
    }),
    api('/api/v1/workspace/ownership/transfer', {
      method: 'POST', headers: ws.auth.owner, body: { userId: String(second._id), password: PASSWORD },
    }),
  ]);
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 200).length, 1, `statuses ${statuses}`);
  const ownerRoleId = await roleId(ws.tenantId, 'Owner');
  const { UserRole } = await import('../../src/models/UserRole.js');
  const owners = await UserRole.find({ tenantId: ws.tenantId, roleId: ownerRoleId }).lean();
  assert.equal(owners.length, 1, 'exactly one Owner after two racing transfers');
  const tenant = await tenantRepository.findById(ws.tenantId);
  assert.equal(String(tenant.ownerId), owners[0].userId);
});

test('platform admin owner reassignment uses the same ownership swap', async () => {
  const ws = await setup();
  const { tenant } = await (await import('../../src/services/tenantOwnership.service.js')).transferOwnership({
    tenantId: ws.tenantId, toUserId: String(ws.viewer._id), by: 'platform-admin-id', actorType: 'admin', reason: 'Owner left; ticket 42',
  });
  assert.equal(String(tenant.ownerId), String(ws.viewer._id));
  assert.deepEqual(await roleNamesOf(ws.tenantId, ws.viewer._id), ['Owner', 'Viewer']);
  assert.deepEqual(await roleNamesOf(ws.tenantId, ws.owner._id), ['Admin']);
  const audit = await AuditLog.findOne({ action: 'tenant.owner_changed', tenantId: ws.tenantId }).lean();
  assert.equal(audit.actorType, 'admin');
  assert.equal(audit.reason, 'Owner left; ticket 42');
  // Service-level listing agrees.
  const list = await tenantMemberService.listMembers({ tenantId: ws.tenantId });
  assert.equal(list.docs.find((m) => m.isPrimaryOwner).id, String(ws.viewer._id));
});
