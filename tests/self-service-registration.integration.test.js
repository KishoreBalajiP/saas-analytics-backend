/**
 * Public self-service registration + verification flow.
 *
 * Ensures a new workspace owner can register, receives an email verification
 * link, is blocked before verification, and can successfully log in after
 * verification completes.
 */

import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api, apiMultipart, refreshCookieFrom } from './helpers/http.js';
import { captureInto, stopCapture } from '../src/services/email.service.js';
import tenantRepository from '../src/repositories/tenant.repository.js';
import userRepository from '../src/repositories/user.repository.js';
import { registerConnectorConsumer } from '../src/queues/connector.queue.js';
import { EmailVerificationToken } from '../src/models/EmailVerificationToken.js';

before(async () => {
  await startMongo();
  await startHttp();
  registerConnectorConsumer();
});

beforeEach(async () => {
  await resetMongo();
  captureInto([]);
});

afterEach(() => {
  stopCapture();
});

after(async () => {
  await stopHttp();
  await stopMongo();
});

test('public registration creates a pending tenant and blocks login before verification', async () => {
  const emails = [];
  captureInto(emails);

  const res = await api('/api/v1/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'Password123!',
      workspaceName: 'Ada Analytics',
      workspaceSlug: 'ada-analytics',
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.json.success, true);
  assert.equal(res.json.data.email, 'ada@example.com');
  assert.equal(res.json.data.tenant.status, 'pending');
  assert.equal(res.json.data.tenant.slug, 'ada-analytics');
  assert.equal(emails.length, 1);
  assert.match(emails[0].text, /verify/i);

  const loginBeforeVerify = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': res.json.data.tenant.id },
    body: { email: 'ada@example.com', password: 'Password123!' },
  });

  assert.equal(loginBeforeVerify.status, 403);
  assert.equal(loginBeforeVerify.json.message, 'Email verification required');
  const protectedRequest = await api('/api/v1/connectors');
  assert.equal(protectedRequest.status, 401);
});

test('verification token activates the tenant and allows login', async () => {
  const emails = [];
  captureInto(emails);

  const signup = await api('/api/v1/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'Password123!',
      workspaceName: 'Grace Ops',
      workspaceSlug: 'grace-ops',
    },
  });

  assert.equal(signup.status, 201);
  const tokenMatch = emails[0].text.match(/token=([^\s&]+)/i);
  assert.ok(tokenMatch, 'verification token should be present in the emailed body');

  const verify = await api('/api/v1/auth/verify-email', {
    method: 'POST',
    body: { token: tokenMatch[1] },
  });

  assert.equal(verify.status, 200);
  assert.equal(verify.json.data.verified, true);
  assert.equal(verify.json.data.tenant.status, 'active');

  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': verify.json.data.tenant.id },
    body: { email: 'grace@example.com', password: 'Password123!' },
  });

  assert.equal(login.status, 200);
  assert.equal(login.json.data.actor.email, 'grace@example.com');
  assert.equal(login.json.data.actor.status, 'active');

  const replay = await api('/api/v1/auth/verify-email', {
    method: 'POST',
    body: { token: tokenMatch[1] },
  });
  assert.equal(replay.status, 400);

  const provisionedTenant = await tenantRepository.findById(signup.json.data.tenant.id);
  const provisionedOwner = await userRepository.findById(signup.json.data.owner.id);
  assert.equal(String(provisionedTenant.ownerId), signup.json.data.owner.id);
  assert.equal(provisionedOwner.status, 'active');
});

test('verification cannot reactivate a suspended workspace', async () => {
  const emails = [];
  captureInto(emails);
  const signup = await api('/api/v1/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Katherine Johnson',
      email: 'katherine@example.com',
      password: 'Password123!',
      workspaceName: 'Orbital Analytics',
      workspaceSlug: 'orbital-analytics',
    },
  });
  const token = emails[0].text.match(/token=([^\s&]+)/i)?.[1];
  assert.ok(token);

  await tenantRepository.update(signup.json.data.tenant.id, { status: 'suspended' });
  const verify = await api('/api/v1/auth/verify-email', { method: 'POST', body: { token } });

  assert.equal(verify.status, 403);
  const tenant = await tenantRepository.findById(signup.json.data.tenant.id);
  const owner = await userRepository.findById(signup.json.data.owner.id);
  assert.equal(tenant.status, 'suspended');
  assert.equal(owner.status, 'unverified');
});

test('expired verification tokens cannot activate an owner or tenant', async () => {
  const emails = [];
  captureInto(emails);
  const signup = await api('/api/v1/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Expired Link Owner',
      email: 'expired-owner@example.com',
      password: 'Password123!',
      workspaceName: 'Expired Link Workspace',
      workspaceSlug: 'expired-link-workspace',
    },
  });
  const token = new URL(emails[0].text.match(/https?:\/\/[^\s]+/u)[0]).searchParams.get('token');
  await EmailVerificationToken.updateOne(
    { tenantId: signup.json.data.tenant.id, status: 'pending' },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );

  const verify = await api('/api/v1/auth/verify-email', { method: 'POST', body: { token } });

  assert.equal(verify.status, 400);
  const tenant = await tenantRepository.findById(signup.json.data.tenant.id);
  const owner = await userRepository.findById(signup.json.data.owner.id);
  assert.equal(tenant.status, 'pending');
  assert.equal(owner.status, 'unverified');
});

test('concurrent verification provisions one owner and consumes the token once', async () => {
  const emails = [];
  captureInto(emails);
  const signup = await api('/api/v1/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Concurrent Owner',
      email: 'concurrent-owner@example.com',
      password: 'Password123!',
      workspaceName: 'Concurrent Verify Workspace',
      workspaceSlug: 'concurrent-verify-workspace',
    },
  });
  const token = new URL(emails[0].text.match(/https?:\/\/[^\s]+/u)[0]).searchParams.get('token');
  const results = await Promise.all([
    api('/api/v1/auth/verify-email', { method: 'POST', body: { token } }),
    api('/api/v1/auth/verify-email', { method: 'POST', body: { token } }),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  const tenant = await tenantRepository.findById(signup.json.data.tenant.id);
  const owner = await userRepository.findById(signup.json.data.owner.id);
  assert.equal(tenant.status, 'active');
  assert.equal(String(tenant.ownerId), String(owner._id));
  assert.equal(owner.status, 'active');
});

test('concurrent registration for the same workspace URL has one winner', async () => {
  const register = () => api('/api/v1/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'Password123!',
      workspaceName: 'Concurrent Analytics',
      workspaceSlug: 'concurrent-analytics',
    },
  });
  const results = await Promise.all([register(), register()]);

  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
});

test('fresh owner completes the authenticated CSV-to-dashboard onboarding flow', async () => {
  const emails = [];
  captureInto(emails);
  const signup = await api('/api/v1/auth/register', {
    method: 'POST',
    body: {
      fullName: 'End To End Owner',
      email: 'e2e-owner@example.com',
      password: 'Password123!',
      workspaceName: 'End To End Workspace',
      workspaceSlug: 'end-to-end-workspace',
    },
  });
  assert.equal(signup.status, 201);
  const verificationToken = new URL(emails[0].text.match(/https?:\/\/[^\s]+/u)[0]).searchParams.get('token');
  const verified = await api('/api/v1/auth/verify-email', { method: 'POST', body: { token: verificationToken } });
  assert.equal(verified.status, 200);
  const tenant = await tenantRepository.findById(verified.json.data.tenant.id);
  assert.equal(String(tenant.ownerId), signup.json.data.owner.id);

  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': 'end-to-end-workspace' },
    body: { email: 'e2e-owner@example.com', password: 'Password123!' },
  });
  assert.equal(login.status, 200);
  const authorization = { Authorization: `Bearer ${login.json.data.accessToken}` };
  const connector = await api('/api/v1/connectors', {
    method: 'POST',
    headers: authorization,
    body: { type: 'csv', name: 'Orders', config: { delimiter: ',', hasHeader: true } },
  });
  assert.equal(connector.status, 201);
  const connectorId = connector.json.data._id;

  const validation = await api(`/api/v1/connectors/${connectorId}/validate`, { method: 'POST', headers: authorization, body: {} });
  assert.equal(validation.status, 200);
  assert.equal(validation.json.data.valid, true);

  const file = { name: 'orders.csv', type: 'text/csv', buffer: Buffer.from('order_id,total\norder-1,42\norder-2,99\n') };
  const preview = await apiMultipart(`/api/v1/connectors/${connectorId}/preview`, { headers: authorization, file });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json.data.fields, ['order_id', 'total']);
  assert.equal(preview.json.data.sample.length, 2);

  const sync = await apiMultipart(`/api/v1/connectors/${connectorId}/sync`, { headers: authorization, file });
  assert.equal(sync.status, 202);
  assert.equal(sync.json.data.accepted, true);
  let synced = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = await api(`/api/v1/connectors/${connectorId}`, { headers: authorization });
    if (detail.json?.data?.lastSyncedAt) {
      synced = detail.json.data;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(synced, 'the worker should persist a successful sync timestamp');
  assert.equal(synced.syncStatus, 'succeeded');
  const rows = await api(`/api/v1/connectors/${connectorId}/rows?page=1&limit=10`, { headers: authorization });
  assert.equal(rows.status, 200);
  assert.equal(rows.json.meta.total, 2);

  const dashboard = await api('/api/v1/dashboards', {
    method: 'POST',
    headers: authorization,
    body: { name: 'First overview', description: 'Onboarding dashboard' },
  });
  assert.equal(dashboard.status, 201);
  const dashboardRead = await api(`/api/v1/dashboards/${dashboard.json.data._id}`, { headers: authorization });
  assert.equal(dashboardRead.status, 200);
  assert.equal(dashboardRead.json.data.name, 'First overview');

  const invite = await api('/api/v1/invitations', {
    method: 'POST',
    headers: authorization,
    body: { email: 'e2e-teammate@example.com', roleName: 'Viewer' },
  });
  assert.equal(invite.status, 201);
  assert.equal(invite.json.data.delivered, true);
  assert.equal(invite.json.data.invitation.roleName, 'Viewer');

  const logout = await api('/api/v1/auth/logout', {
    method: 'POST',
    cookies: [refreshCookieFrom(login)],
  });
  assert.equal(logout.status, 200);
  const relogin = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': 'end-to-end-workspace' },
    body: { email: 'e2e-owner@example.com', password: 'Password123!' },
  });
  assert.equal(relogin.status, 200);
  const resumedAuth = { Authorization: `Bearer ${relogin.json.data.accessToken}` };
  const resumedConnectors = await api('/api/v1/connectors?page=1&limit=100', { headers: resumedAuth });
  const resumedDashboards = await api('/api/v1/dashboards?page=1&limit=100', { headers: resumedAuth });
  assert.equal(resumedConnectors.json.meta.total, 1);
  assert.equal(resumedDashboards.json.meta.total, 1);
});
