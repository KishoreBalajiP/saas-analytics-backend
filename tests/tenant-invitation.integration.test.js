import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import { factories } from './helpers/factories.js';
import * as emailService from '../src/services/email.service.js';
import tenantService from '../src/services/tenant.service.js';
import invitationService from '../src/services/tenantInvitation.service.js';
import { TenantInvitation } from '../src/models/TenantInvitation.js';
import { User } from '../src/models/User.js';
import { UserRole } from '../src/models/UserRole.js';
import { verify } from '../src/utils/password.js';

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); });
after(async () => { await emailService.close(); await stopHttp(); await stopMongo(); });

const PASSWORD = 'InvitePassword123!';

async function createTenantWithInvitation(email = `invite-${randomBytes(4).toString('hex')}@example.com`) {
  const sink = [];
  emailService.captureInto(sink);
  const result = await tenantService.create({
    tenant: { name: `Invite Workspace ${randomBytes(3).toString('hex')}` },
    owner: { email, name: 'Invite Owner' }, initialize: true, by: 'platform-admin',
  });
  emailService.stopCapture();
  const link = sink[0]?.text.match(/https?:\/\/[^\s]+/u)?.[0];
  assert.ok(link);
  return { ...result, email, token: new URL(link).searchParams.get('token') };
}

test('tenant creation creates an invitation without a plaintext password and acceptance activates the owner', async () => {
  const result = await createTenantWithInvitation();
  assert.ok(result.invitation);
  assert.equal(result.invitation.tokenHash, undefined);
  const accepted = await invitationService.accept({ token: result.token, name: 'Accepted Owner', password: PASSWORD });
  assert.equal(accepted.ok, true);
  const user = await User.findOne({ tenantId: result.tenant._id, email: result.email }).lean();
  assert.equal(user.status, 'active');
  assert.equal(await verify(PASSWORD, user.passwordHash), true);
  assert.equal((await UserRole.findOne({ tenantId: result.tenant._id, userId: String(user._id) }).lean()).roleId.length > 0, true);
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': result.tenant.slug }, body: { email: result.email, password: PASSWORD } });
  assert.equal(login.status, 200);
});

test('reused and cross-tenant tokens fail safely', async () => {
  const first = await createTenantWithInvitation();
  const second = await createTenantWithInvitation();
  await invitationService.accept({ token: first.token, name: 'A', password: PASSWORD });
  await assert.rejects(() => invitationService.accept({ token: first.token, name: 'A', password: PASSWORD }), /invalid|expired|available/i);
  const initialSink = []; emailService.captureInto(initialSink);
  await invitationService.create({ tenantId: first.tenant._id, email: 'another@example.com', name: 'Another', invitedBy: 'platform-admin' });
  emailService.stopCapture();
  const oldToken = new URL(initialSink[0].text.match(/https?:\/\/[^\s]+/u)[0]).searchParams.get('token');
  const resendSink = []; emailService.captureInto(resendSink);
  await invitationService.resend({ tenantId: first.tenant._id, email: 'another@example.com', name: 'Another', invitedBy: 'platform-admin' });
  emailService.stopCapture();
  assert.ok(resendSink.length);
  await assert.rejects(() => invitationService.accept({ token: oldToken, name: 'Nope', password: PASSWORD }), /invalid|expired|available/i);
  assert.notEqual(String(first.tenant._id), String(second.tenant._id));
});

test('expired invitations cannot be previewed or accepted', async () => {
  const result = await createTenantWithInvitation();
  const expired = await TenantInvitation.updateOne({ invitedEmail: result.email, status: 'pending' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal(expired.modifiedCount ?? expired.nModified, 1);
  await assert.rejects(() => invitationService.preview(result.token), /invalid|expired|available/i);
  await assert.rejects(() => invitationService.accept({ token: result.token, name: 'Expired', password: PASSWORD }), /invalid|expired|available/i);
});

test('invitation creation requires an inviter and resend invalidates the previous pending invitation', async () => {
  const tenant = await factories.tenant.create();
  await tenantService.initialize({ tenantId: tenant._id, owner: { email: 'seed@example.com', name: 'Seed' }, by: 'platform-admin' });
  await assert.rejects(() => invitationService.create({ tenantId: tenant._id, email: 'x@example.com' }), /Inviter is required/);
  const firstSink = []; emailService.captureInto(firstSink);
  const first = await invitationService.create({ tenantId: tenant._id, email: 'x@example.com', invitedBy: 'platform-admin' });
  emailService.stopCapture();
  const secondSink = []; emailService.captureInto(secondSink);
  const second = await invitationService.resend({ tenantId: tenant._id, email: 'x@example.com', invitedBy: 'platform-admin' });
  emailService.stopCapture();
  assert.ok(firstSink.length && secondSink.length);
  const old = await TenantInvitation.findById(first.invitation._id).lean();
  assert.equal(old.status, 'revoked');
  assert.equal(second.invitation.status, 'pending');
});

test('concurrent acceptance permits exactly one consumer', async () => {
  const result = await createTenantWithInvitation();
  const outcomes = await Promise.allSettled([
    invitationService.accept({ token: result.token, name: 'First', password: PASSWORD }),
    invitationService.accept({ token: result.token, name: 'Second', password: PASSWORD }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
});

test('invalid token preview does not disclose tenant information', async () => {
  await assert.rejects(() => invitationService.preview('not-a-real-token-value-1234567890'), /invalid|expired|available/i);
  const response = await api('/api/v1/invitations/preview?token=not-a-real-token-value-1234567890');
  assert.equal(response.status, 400);
  assert.equal(response.json.data, undefined);
});

test('tenant owner can invite once, retry idempotently, and cannot select another tenant', async () => {
  const emails = [];
  emailService.captureInto(emails);
  const registration = await api('/api/v1/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Workspace Owner',
      email: 'owner-onboarding@example.com',
      password: PASSWORD,
      workspaceName: 'Onboarding Invite Workspace',
      workspaceSlug: 'onboarding-invite-workspace',
    },
  });
  assert.equal(registration.status, 201);
  const verificationToken = new URL(emails[0].text.match(/https?:\/\/[^\s]+/u)[0]).searchParams.get('token');
  const verified = await api('/api/v1/auth/verify-email', { method: 'POST', body: { token: verificationToken } });
  assert.equal(verified.status, 200);
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': 'onboarding-invite-workspace' },
    body: { email: 'owner-onboarding@example.com', password: PASSWORD },
  });
  assert.equal(login.status, 200);
  const authorization = { Authorization: `Bearer ${login.json.data.accessToken}` };

  const invite = await api('/api/v1/invitations', {
    method: 'POST',
    headers: authorization,
    body: { email: 'teammate@example.com', name: 'A Teammate' },
  });
  assert.equal(invite.status, 201);
  assert.equal(invite.json.data.delivered, true);
  assert.equal(invite.json.data.invitation.roleName, 'Viewer');

  const retry = await api('/api/v1/invitations', {
    method: 'POST',
    headers: authorization,
    body: { email: 'teammate@example.com', name: 'A Teammate' },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.data.alreadyPending, true);
  assert.equal(retry.json.data.invitation._id, invite.json.data.invitation._id);
  assert.equal(emails.filter((email) => email.subject === 'You are invited to Analivo').length, 1);

  const forgedTenant = await api('/api/v1/invitations', {
    method: 'POST',
    headers: { ...authorization, 'X-Tenant-Id': 'some-other-tenant' },
    body: { email: 'cross-tenant@example.com' },
  });
  assert.equal(forgedTenant.status, 403);
});
