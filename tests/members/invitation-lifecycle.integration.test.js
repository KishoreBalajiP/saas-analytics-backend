/**
 * Members package (roadmap 2.10; ten.12): invitation lifecycle.
 *
 * Covers: configurable link lifetime (days, not the 15-minute reset TTL),
 * history kept for accepted / revoked / expired invitations (no TTL index),
 * the expiry sweep (status `expired`, provisional grant dropped, seat given
 * back), resend re-issuing the link in place (seat kept) or re-creating an
 * expired invitation, revoke within the role ceiling, and tenant isolation
 * of the workspace invitation endpoints.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import env from '../../src/config/env.js';
import * as emailService from '../../src/services/email.service.js';
import invitationService from '../../src/services/tenantInvitation.service.js';
import invitationExpiryJob from '../../src/jobs/invitationExpiry.job.js';
import { runJob, resetSchedulerForTests } from '../../src/jobs/scheduler.js';
import { TenantInvitation } from '../../src/models/TenantInvitation.js';
import { User } from '../../src/models/User.js';
import { UserRole } from '../../src/models/UserRole.js';
import { PASSWORD, createWorkspace, addMember, signIn, seatCount } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const originalTtl = env.members.invitationTtlDays;

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); env.members.invitationTtlDays = originalTtl; resetSchedulerForTests(); });
after(async () => { env.members.invitationTtlDays = originalTtl; await emailService.close(); await stopHttp(); await stopMongo(); });

function tokenFrom(message) {
  return new URL(message.text.match(/https?:\/\/[^\s]+/u)[0]).searchParams.get('token');
}

async function invite(headers, body) {
  const sink = [];
  emailService.captureInto(sink);
  const res = await api('/api/v1/workspace/invitations', { method: 'POST', headers, body });
  emailService.stopCapture();
  return { res, mail: sink[0] ?? null };
}

test('the invitation lifetime is configurable in days and the email says so', async () => {
  env.members.invitationTtlDays = 3;
  const ws = await createWorkspace();
  const owner = await signIn(ws.tenant, ws.ownerEmail);
  const started = Date.now();
  const { res, mail } = await invite(owner, { email: 'three-days@example.com', roleName: 'Viewer' });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const expiresAt = new Date(res.json.data.invitation.expiresAt).getTime();
  assert.ok(Math.abs(expiresAt - (started + 3 * DAY)) < 60_000, 'expires three days out');
  assert.match(mail.text, /expires in 3 days/);
  assert.equal(invitationService.invitationTtlMs(), 3 * DAY);
});

test('invitation history is kept: no TTL index, and expired rows stay with status `expired`', async () => {
  const indexes = await TenantInvitation.collection.indexes();
  assert.ok(indexes.every((i) => i.expireAfterSeconds === undefined), 'no TTL index on invitations');

  const ws = await createWorkspace();
  const owner = await signIn(ws.tenant, ws.ownerEmail);
  const seatsBefore = await seatCount(ws.tenantId);
  const { res, mail } = await invite(owner, { email: 'late@example.com', roleName: 'Viewer' });
  assert.equal(res.status, 201);
  assert.equal(await seatCount(ws.tenantId), seatsBefore + 1, 'a pending invitee holds a seat');
  const invitee = await User.findOne({ tenantId: ws.tenantId, email: 'late@example.com' }).lean();
  assert.equal(await UserRole.countDocuments({ tenantId: ws.tenantId, userId: String(invitee._id) }), 1);

  // Not due yet: the sweep leaves it alone.
  const notYet = await invitationService.expireDue();
  assert.equal(notYet.expired, 0);

  await TenantInvitation.updateOne({ _id: res.json.data.invitation._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const run = await runJob(invitationExpiryJob, { trigger: 'manual' });
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  assert.equal(run.counts.expired, 1);
  assert.equal(run.counts.seatsReleased, 1);

  const row = await TenantInvitation.findById(res.json.data.invitation._id).lean();
  assert.ok(row, 'the row is kept as history');
  assert.equal(row.status, 'expired');
  assert.ok(row.expiredAt);
  assert.equal(await seatCount(ws.tenantId), seatsBefore, 'the seat is given back');
  assert.equal(await UserRole.countDocuments({ tenantId: ws.tenantId, userId: String(invitee._id) }), 0, 'provisional grant dropped');
  await assert.rejects(() => invitationService.accept({ token: tokenFrom(mail), name: 'Late', password: PASSWORD }), /invalid|expired|available/i);

  // The sweep is idempotent.
  assert.equal((await invitationService.expireDue()).expired, 0);

  const history = await api('/api/v1/workspace/invitations?status=expired', { headers: owner });
  assert.equal(history.status, 200);
  assert.equal(history.json.data.length, 1);
  assert.equal(history.json.data[0].tokenHash, undefined);
});

test('resend re-issues the link in place and keeps the seat; an expired invitation is re-created', async () => {
  const ws = await createWorkspace();
  const owner = await signIn(ws.tenant, ws.ownerEmail);
  const { res, mail } = await invite(owner, { email: 'again@example.com', roleName: 'Viewer' });
  const id = res.json.data.invitation._id;
  const seats = await seatCount(ws.tenantId);

  const sink = [];
  emailService.captureInto(sink);
  const resent = await api(`/api/v1/workspace/invitations/${id}/resend`, { method: 'POST', headers: owner, body: {} });
  emailService.stopCapture();
  assert.equal(resent.status, 200, JSON.stringify(resent.json));
  assert.equal(resent.json.data.invitation._id, id);
  assert.equal(resent.json.data.invitation.resendCount, 1);
  assert.equal(await seatCount(ws.tenantId), seats, 'resend does not take another seat');
  await assert.rejects(() => invitationService.preview(tokenFrom(mail)), /invalid|expired|available/i);
  assert.equal((await invitationService.preview(tokenFrom(sink[0]))).invitedEmail, 'again@example.com');

  // Expire it, then resend: a new pending invitation takes the seat again.
  await TenantInvitation.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await invitationService.expireDue();
  assert.equal(await seatCount(ws.tenantId), seats - 1);
  const recreated = await api(`/api/v1/workspace/invitations/${id}/resend`, { method: 'POST', headers: owner, body: {} });
  assert.equal(recreated.status, 200, JSON.stringify(recreated.json));
  assert.notEqual(recreated.json.data.invitation._id, id);
  assert.equal(recreated.json.data.invitation.status, 'pending');
  assert.equal(await seatCount(ws.tenantId), seats);
  assert.equal((await TenantInvitation.findById(id).lean()).status, 'expired', 'the expired row stays as history');

  // Accepted invitations cannot be resent.
  const latest = await TenantInvitation.findById(recreated.json.data.invitation._id).lean();
  await TenantInvitation.updateOne({ _id: latest._id }, { $set: { status: 'accepted' } });
  const acceptedResend = await api(`/api/v1/workspace/invitations/${latest._id}/resend`, { method: 'POST', headers: owner, body: {} });
  assert.equal(acceptedResend.status, 409);
});

test('revoke keeps the row, drops the grant, frees the seat and respects the ceiling', async () => {
  const ws = await createWorkspace();
  const admin = await addMember({ tenantId: ws.tenantId, roleName: 'Admin' });
  const owner = await signIn(ws.tenant, ws.ownerEmail);
  const asAdmin = await signIn(ws.tenant, admin.email);

  // A platform-created Owner invitation is above an Admin's ceiling.
  const ownerInvite = await invitationService.create({
    tenantId: ws.tenantId, email: 'co-owner@example.com', roleName: 'Owner', invitedBy: 'platform-admin', actorType: 'admin',
  });
  const denied = await api(`/api/v1/workspace/invitations/${ownerInvite.invitation._id}/revoke`, { method: 'POST', headers: asAdmin, body: {} });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'ROLE_CEILING');

  const seats = await seatCount(ws.tenantId);
  const revoked = await api(`/api/v1/workspace/invitations/${ownerInvite.invitation._id}/revoke`, { method: 'POST', headers: owner, body: {} });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  assert.equal(revoked.json.data.status, 'revoked');
  assert.ok(revoked.json.data.revokedBy);
  assert.equal(await seatCount(ws.tenantId), seats - 1);
  const invitee = await User.findOne({ tenantId: ws.tenantId, email: 'co-owner@example.com' }).lean();
  assert.equal(await UserRole.countDocuments({ tenantId: ws.tenantId, userId: String(invitee._id) }), 0);

  const again = await api(`/api/v1/workspace/invitations/${ownerInvite.invitation._id}/revoke`, { method: 'POST', headers: owner, body: {} });
  assert.equal(again.status, 409);

  // Everything is history now: accepted, revoked and pending rows are listed.
  const { res: viewerInvite, mail } = await invite(owner, { email: 'joins@example.com', roleName: 'Viewer' });
  assert.equal(viewerInvite.status, 201);
  await invitationService.accept({ token: tokenFrom(mail), name: 'Joiner', password: PASSWORD });
  const all = await api('/api/v1/workspace/invitations', { headers: owner });
  const statuses = all.json.data.map((i) => i.status).sort();
  assert.deepEqual(statuses, ['accepted', 'revoked']);
});

test('workspace invitation endpoints are tenant-isolated and permission-gated', async () => {
  const a = await createWorkspace('A');
  const b = await createWorkspace('B');
  const viewer = await addMember({ tenantId: a.tenantId, roleName: 'Viewer' });
  const aOwner = await signIn(a.tenant, a.ownerEmail);
  const bOwner = await signIn(b.tenant, b.ownerEmail);
  const aViewer = await signIn(a.tenant, viewer.email);
  const { res } = await invite(bOwner, { email: 'b-only@example.com', roleName: 'Viewer' });
  const bInvitation = res.json.data.invitation._id;

  for (const action of ['resend', 'revoke']) {
    const cross = await api(`/api/v1/workspace/invitations/${bInvitation}/${action}`, { method: 'POST', headers: aOwner, body: {} });
    assert.equal(cross.status, 404, `${action} across tenants`);
  }
  const aList = await api('/api/v1/workspace/invitations', { headers: aOwner });
  assert.equal(aList.json.data.length, 0);
  const viewerList = await api('/api/v1/workspace/invitations', { headers: aViewer });
  assert.equal(viewerList.status, 403);
  const viewerInvite = await api('/api/v1/workspace/invitations', { method: 'POST', headers: aViewer, body: { email: 'x@example.com' } });
  assert.equal(viewerInvite.status, 403);
  assert.equal((await TenantInvitation.findById(bInvitation).lean()).status, 'pending');
});
