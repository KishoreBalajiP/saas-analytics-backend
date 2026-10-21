/**
 * Phase 6.1 - Razorpay billing tests (mocked provider boundary only).
 *
 * PURPOSE
 *   End-to-end coverage of the one-time order flow against the REAL
 *   Express app, REAL services and REAL Mongo (memory server). Only the
 *   external Razorpay SDK boundary is mocked (injected test provider +
 *   test pricing map); no live credentials, no network.
 *
 * COVERAGE
 *   Unit (no DB): checkout/webhook HMAC verification, pricing resolver,
 *   webhook normalization + allowlist.
 *   Integration: checkout auth/validation/idempotency/provider errors,
 *   verify success/forgery/mismatch/idempotency/isolation, webhook
 *   signature/duplicates/out-of-order/unsupported/unknown/failure/refund,
 *   lifecycle guards (suspended tenant, restricted), entitlement sync,
 *   reconciliation, admin visibility, disabled-provider 501s.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import { startHttp, stopHttp, api } from './helpers/http.js';
import { factories } from './helpers/factories.js';
import planService from '../src/services/plan.service.js';
import rbacCache from '../src/services/rbac.cache.service.js';
import permissionRepository from '../src/repositories/permission.repository.js';
import roleRepository from '../src/repositories/role.repository.js';
import { RolePermission } from '../src/models/RolePermission.js';
import { UserRole } from '../src/models/UserRole.js';
import { AdminRole } from '../src/models/AdminRole.js';
import { Tenant } from '../src/models/Tenant.js';
import adminBootstrapService from '../src/services/adminBootstrap.service.js';
import ApiError from '../src/utils/ApiError.js';
import {
  hmacHex,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  normalizeWebhookEvent,
  __setTestProvider,
  __clearTestProviders,
} from '../src/services/paymentProvider.adapter.js';
import billingPricing, {
  __setTestMapping,
  __clearTestMapping,
} from '../src/services/billingPricing.service.js';
import billingLifecycle from '../src/services/billingLifecycle.service.js';
import subscriptionService from '../src/services/subscription.service.js';
import paymentTransactionRepository from '../src/repositories/paymentTransaction.repository.js';
// billing (roadmap 3.1): webhooks are processed from the stored event, off
// the request path; tests wait for that processing before asserting.
import billingWebhookService from '../src/services/billingWebhook.service.js';
import WebhookEvent from '../src/models/WebhookEvent.js';
import clock from '../src/utils/clock.js';

const PASSWORD = 'Password123!';
const PREFIX = '/api/v1';

const TEST_KEY_SECRET = 'test_key_secret_1234567890';
const TEST_WEBHOOK_SECRET = 'test_webhook_secret_1234567890';
const TEST_MAPPING = Object.freeze({
  starter: { amountMinor: 49900, currency: 'INR', interval: 'one-time' },
  pro: { amountMinor: 99900, currency: 'INR', interval: 'one-time' },
});

/* ------------------------- mock provider ------------------------------- */

function makeMockProvider({ keySecret = TEST_KEY_SECRET, webhookSecret = TEST_WEBHOOK_SECRET, hooks = {} } = {}) {
  const calls = { createOrder: 0, fetchOrder: 0, fetchPayment: 0 };
  const state = { orders: new Map(), payments: new Map(), seq: 0 };
  return {
    calls,
    state,
    name: 'razorpay',
    isImplemented: true,
    environment: 'test',
    keyId: 'rzp_test_public123',
    async createOrder({ amountMinor, currency, receipt, notes }) {
      calls.createOrder += 1;
      if (hooks.createOrder === 'throw') throw ApiError.serviceUnavailable('provider down');
      const id = `order_test_${++state.seq}_${Date.now().toString(36)}`;
      const order = { id, amount: amountMinor, currency, receipt, status: 'created' };
      state.orders.set(id, order);
      return order;
    },
    async fetchOrder(orderId) {
      calls.fetchOrder += 1;
      if (typeof hooks.fetchOrder === 'function') return hooks.fetchOrder(orderId);
      const o = state.orders.get(orderId);
      if (!o) throw ApiError.notFound('order not found');
      return { ...o };
    },
    async fetchPayment(paymentId) {
      calls.fetchPayment += 1;
      if (typeof hooks.fetchPayment === 'function') return hooks.fetchPayment(paymentId);
      const p = state.payments.get(paymentId);
      if (!p) throw ApiError.notFound('payment not found');
      return { ...p };
    },
    async fetchOrderPayments(orderId) {
      return [...state.payments.values()].filter((p) => p.order_id === orderId).map((p) => ({ ...p }));
    },
    verifyCheckoutSignature({ orderId, paymentId, signature }) {
      return verifyCheckoutSignature({ orderId, paymentId, signature, keySecret });
    },
    verifyWebhookSignature(rawBody, signature) {
      return verifyWebhookSignature({ rawBody, signature, webhookSecret });
    },
    normalizeWebhookEvent,
    async cancel() {
      return { canceled: false, reason: 'one_time_orders_not_cancelable_at_provider' };
    },
    async handleWebhook() {
      return { handled: false, reason: 'noop' };
    },
    async createCheckoutSession() {
      throw ApiError.notImplemented('use createOrder');
    },
    async reconcile() {
      return [];
    },
  };
}

let mock;
function installMock(hooks) {
  mock = makeMockProvider({ hooks });
  __setTestProvider('razorpay', mock);
  return mock;
}

/* ------------------------- unit: signatures ---------------------------- */

test('checkout signature: valid HMAC verifies, tampered/forged do not', () => {
  const orderId = 'order_abc';
  const paymentId = 'pay_abc';
  const good = hmacHex(TEST_KEY_SECRET, `${orderId}|${paymentId}`);
  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature: good, keySecret: TEST_KEY_SECRET }), true);
  assert.equal(
    verifyCheckoutSignature({ orderId, paymentId: 'pay_other', signature: good, keySecret: TEST_KEY_SECRET }),
    false,
  );
  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature: 'deadbeef', keySecret: TEST_KEY_SECRET }), false);
  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature: '', keySecret: TEST_KEY_SECRET }), false);
  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature: good, keySecret: 'wrong' }), false);
});

test('webhook signature: exact raw bytes verify, tampered body does not', () => {
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured' }), 'utf8');
  const good = hmacHex(TEST_WEBHOOK_SECRET, raw);
  assert.equal(verifyWebhookSignature({ rawBody: raw, signature: good, webhookSecret: TEST_WEBHOOK_SECRET }), true);
  const tampered = Buffer.from(JSON.stringify({ event: 'payment.captured', extra: 1 }), 'utf8');
  assert.equal(verifyWebhookSignature({ rawBody: tampered, signature: good, webhookSecret: TEST_WEBHOOK_SECRET }), false);
  assert.equal(verifyWebhookSignature({ rawBody: raw, signature: null, webhookSecret: TEST_WEBHOOK_SECRET }), false);
});

/* ------------------------- unit: pricing ------------------------------- */

test('pricing resolver: valid, unmapped, malformed, free', () => {
  __setTestMapping({ ...TEST_MAPPING });
  try {
    // billing: the legacy flat one-time entry is read as a monthly term.
    assert.deepEqual(billingPricing.resolvePrice('pro'), {
      planCode: 'pro',
      amountMinor: 99900,
      currency: 'INR',
      interval: 'month',
      termMonths: 1,
    });
    assert.equal(billingPricing.isPurchasable('pro'), true);
    assert.equal(billingPricing.isPurchasable('free'), false);
    assert.equal(billingPricing.isPurchasable('enterprise'), false);
    assert.throws(() => billingPricing.resolvePrice('enterprise'), /no configured/);
    __setTestMapping({ bad: { amountMinor: 99.5, currency: 'INR', interval: 'one-time' } });
    assert.throws(() => billingPricing.resolvePrice('bad'), /amountMinor/);
    __setTestMapping({ bad2: { amountMinor: 100, currency: 'USD', interval: 'one-time' } });
    assert.throws(() => billingPricing.resolvePrice('bad2'), /currency/);
    __setTestMapping({ bad3: { amountMinor: 100, currency: 'INR', interval: 'weekly' } });
    assert.throws(() => billingPricing.resolvePrice('bad3'), /interval/);
    const listed = billingPricing.listPricedPlans();
    assert.deepEqual(Object.keys(listed), []);
  } finally {
    __clearTestMapping();
  }
});

test('webhook normalization: allowlist + entity extraction', () => {
  const captured = normalizeWebhookEvent({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 99900, currency: 'INR', status: 'captured' } } },
  });
  assert.equal(captured.supported, true);
  assert.equal(captured.orderId, 'order_1');
  assert.equal(captured.paymentId, 'pay_1');
  // billing: payment.authorized is recorded (it grants nothing).
  assert.equal(normalizeWebhookEvent({ event: 'payment.authorized', payload: {} }).supported, true);
  const unknown = normalizeWebhookEvent({ event: 'payment.dispute.created', payload: {} });
  assert.equal(unknown.supported, false);
  const refund = normalizeWebhookEvent({
    event: 'refund.processed',
    payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 99900 } } },
  });
  assert.equal(refund.supported, true);
  assert.equal(refund.entityId, 'rfnd_1');
});

/* ------------------------- integration setup --------------------------- */

before(async () => {
  await startMongo();
  await startHttp();
});

beforeEach(async () => {
  await billingWebhookService.waitForIdle();
  clock.reset();
  await resetMongo();
  await rbacCache.clearAll();
  await planService.ensureDefaults('test');
  __clearTestProviders();
  __clearTestMapping();
  __setTestMapping({ ...TEST_MAPPING });
  installMock();
});

after(async () => {
  __clearTestProviders();
  __clearTestMapping();
  await stopHttp();
  await stopMongo();
});

async function ensurePermission(key) {
  const lastDot = key.lastIndexOf('.');
  const module = key.slice(0, lastDot);
  const action = key.slice(lastDot + 1);
  let mod = await permissionRepository.findModuleByKey(module);
  if (!mod) {
    mod = await permissionRepository.createModule({ key: module, name: module, isSystem: true, createdBy: 'test' });
  }
  const existing = await permissionRepository.findPermissionByKey(key);
  if (existing) return existing;
  return permissionRepository.registerAction({
    moduleId: mod._id,
    module,
    action,
    description: `${action} ${module}`,
    isSystem: true,
    createdBy: 'test',
  });
}

async function grantPermission(role, permissionKey) {
  const perm = await permissionRepository.findPermissionByKey(permissionKey);
  const already = await RolePermission.findOne({ roleId: role._id, permissionId: perm._id });
  if (already) return;
  await RolePermission.create({ roleId: role._id, permissionId: perm._id, grantedBy: 'test' });
}

async function findOrCreateRole({ tenantId = null, name, level = 'tenant' }) {
  let role = await roleRepository.findByName({ tenantId, name });
  if (role) return role;
  return roleRepository.create({ tenantId, name, description: name, level, isSystem: true, createdBy: 'test' });
}

async function seedTenantWithOwner(planId = 'starter') {
  const tenant = await factories.tenant.create({ planId });
  const ownerUser = await factories.user.create({ tenantId: tenant._id.toString() });
  const managerUser = await factories.user.create({ tenantId: tenant._id.toString() });
  const ownerRole = await findOrCreateRole({ tenantId: tenant._id.toString(), name: 'Owner' });
  const managerRole = await findOrCreateRole({ tenantId: tenant._id.toString(), name: 'Manager' });
  for (const key of ['iam.subscriptions.view', 'iam.subscriptions.update', 'iam.entitlements.view']) {
    await ensurePermission(key);
    await grantPermission(ownerRole, key);
  }
  await grantPermission(managerRole, 'iam.subscriptions.view');
  await UserRole.create({ tenantId: tenant._id.toString(), userId: ownerUser._id.toString(), roleId: ownerRole._id.toString(), createdBy: 'test' });
  await UserRole.create({ tenantId: tenant._id.toString(), userId: managerUser._id.toString(), roleId: managerRole._id.toString(), createdBy: 'test' });
  return { tenant, ownerUser, managerUser };
}

async function loginUser(email, tenantId) {
  const res = await api(`${PREFIX}/auth/login`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    body: { email, password: PASSWORD },
  });
  assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.json)}`);
  return res.json.data.accessToken;
}

async function makeAdmin(email, adminType = 'platform', permissions = []) {
  const bootstrapEmail = `root-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await adminBootstrapService.bootstrapAdmin({ email: bootstrapEmail, password: PASSWORD, adminType: 'super', name: 'Root' });
  const roleName = `${adminType}-${Math.random().toString(36).slice(2, 6)}`;
  const role = await roleRepository.create({ tenantId: null, name: roleName, description: roleName, level: 'platform', isSystem: false, createdBy: 'test' });
  for (const key of permissions) {
    await ensurePermission(key);
    await grantPermission(role, key);
  }
  const admin = await factories.admin.create({ email, adminType });
  await AdminRole.create({ adminId: admin._id.toString(), roleId: role._id.toString(), tenantId: null, createdBy: 'test' });
  return { admin, role };
}

async function loginAdmin(email) {
  const res = await api(`${PREFIX}/admin-auth/login`, { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(res.status, 200, `admin login failed: ${JSON.stringify(res.json)}`);
  return res.json.data.accessToken;
}

function signCheckout(orderId, paymentId) {
  return hmacHex(TEST_KEY_SECRET, `${orderId}|${paymentId}`);
}

function signWebhookBytes(raw) {
  return hmacHex(TEST_WEBHOOK_SECRET, raw);
}

async function postWebhook(payload, { signature = null, autoSign = false } = {}) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = autoSign ? signWebhookBytes(raw) : signature;
  const res = await api(`${PREFIX}/billing/webhook`, {
    method: 'POST',
    headers: sig ? { 'x-razorpay-signature': sig } : {},
    body: payload,
  });
  await billingWebhookService.waitForIdle();
  return res;
}

/** billing: the provider records a captured payment for an order. */
function providerCaptures(orderId, paymentId, amount = 99900) {
  mock.state.payments.set(paymentId, {
    id: paymentId, order_id: orderId, status: 'captured', amount, currency: 'INR', captured: true,
  });
}

async function storedOutcome(orderId) {
  const row = await WebhookEvent.findOne({ 'raw.orderId': orderId }).sort({ createdAt: -1 }).lean();
  return row?.outcome ?? null;
}

function capturedPayload(orderId, paymentId, amount = 99900) {
  return {
    event: 'payment.captured',
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: { entity: { id: paymentId, order_id: orderId, amount, currency: 'INR', status: 'captured' } },
    },
  };
}

/* ------------------------- checkout ------------------------------------ */

test('owner checkout creates a provider order + pending transaction (public fields only)', async () => {
  const { tenant, ownerUser } = await seedTenantWithOwner('starter');
  const token = await loginUser(ownerUser.email, tenant._id.toString());
  const res = await api(`${PREFIX}/tenants/${tenant._id}/subscription/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { planId: 'pro' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const data = res.json.data;
  assert.ok(data.orderId);
  assert.equal(data.keyId, 'rzp_test_public123');
  assert.equal(data.amountMinor, 99900);
  assert.equal(data.currency, 'INR');
  assert.equal(data.planId, 'pro');
  assert.equal(data.reused, false);
  assert.ok(!('keySecret' in data) && !('signature' in data) && !('webhookSecret' in data));
  const txn = await paymentTransactionRepository.findByOrderId(data.orderId);
  assert.equal(txn.status, 'pending');
  assert.equal(txn.amountMinor, 99900);
  // Order creation alone must NOT activate the plan.
  const sub = await subscriptionService.getForTenant(tenant._id.toString());
  assert.equal(sub.planId, 'starter');
});

test('duplicate checkout reuses the pending order (no duplicate provider order)', async () => {
  const { tenant, ownerUser } = await seedTenantWithOwner('starter');
  const token = await loginUser(ownerUser.email, tenant._id.toString());
  const url = `${PREFIX}/tenants/${tenant._id}/subscription/checkout`;
  const auth = { authorization: `Bearer ${token}` };
  const first = await api(url, { method: 'POST', headers: auth, body: { planId: 'pro' } });
  const second = await api(url, { method: 'POST', headers: auth, body: { planId: 'pro' } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.json.data.orderId, first.json.data.orderId);
  assert.equal(second.json.data.reused, true);
  assert.equal(mock.calls.createOrder, 1);
});

test('checkout rejects invalid, free, unmapped and same plans', async () => {
  const { tenant, ownerUser } = await seedTenantWithOwner('starter');
  const token = await loginUser(ownerUser.email, tenant._id.toString());
  const url = `${PREFIX}/tenants/${tenant._id}/subscription/checkout`;
  const auth = { authorization: `Bearer ${token}` };
  const bad = await api(url, { method: 'POST', headers: auth, body: { planId: 'nope' } });
  assert.equal(bad.status, 400);
  const free = await api(url, { method: 'POST', headers: auth, body: { planId: 'free' } });
  assert.equal(free.status, 400);
  const unmapped = await api(url, { method: 'POST', headers: auth, body: { planId: 'enterprise' } });
  assert.equal(unmapped.status, 422);
  // billing: buying the current plan again is a renewal (prepaid terms).
  const same = await api(url, { method: 'POST', headers: auth, body: { planId: 'starter' } });
  assert.equal(same.status, 200);
});

test('checkout: manager without update permission is forbidden; cross-tenant is forbidden', async () => {
  const { tenant, managerUser } = await seedTenantWithOwner('starter');
  const other = await seedTenantWithOwner('starter');
  const managerToken = await loginUser(managerUser.email, tenant._id.toString());
  const forbidden = await api(`${PREFIX}/tenants/${tenant._id}/subscription/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${managerToken}` },
    body: { planId: 'pro' },
  });
  assert.equal(forbidden.status, 403);
  const ownerToken = await loginUser(other.ownerUser.email, other.tenant._id.toString());
  const cross = await api(`${PREFIX}/tenants/${tenant._id}/subscription/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerToken}` },
    body: { planId: 'pro' },
  });
  assert.equal(cross.status, 403);
});

test('checkout fails safely when the provider errors', async () => {
  installMock({ createOrder: 'throw' });
  const { tenant, ownerUser } = await seedTenantWithOwner('starter');
  const token = await loginUser(ownerUser.email, tenant._id.toString());
  const res = await api(`${PREFIX}/tenants/${tenant._id}/subscription/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { planId: 'pro' },
  });
  assert.equal(res.status, 503);
});

test('checkout returns 501 when the provider is disabled', async () => {
  __clearTestProviders();
  const { tenant, ownerUser } = await seedTenantWithOwner('starter');
  const token = await loginUser(ownerUser.email, tenant._id.toString());
  const res = await api(`${PREFIX}/tenants/${tenant._id}/subscription/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { planId: 'pro' },
  });
  assert.equal(res.status, 501);
});

/* ------------------------- verify -------------------------------------- */

async function checkoutAsOwner(planId = 'pro') {
  const { tenant, ownerUser } = await seedTenantWithOwner('starter');
  const token = await loginUser(ownerUser.email, tenant._id.toString());
  const res = await api(`${PREFIX}/tenants/${tenant._id}/subscription/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { planId },
  });
  assert.equal(res.status, 200);
  return { tenant, ownerUser, token, session: res.json.data };
}

test('verify checks the signature but never grants; the verified webhook does (idempotent)', async () => {
  const { tenant, token, session } = await checkoutAsOwner('pro');
  const paymentId = 'pay_verify_ok_1';
  providerCaptures(session.orderId, paymentId);
  const url = `${PREFIX}/tenants/${tenant._id}/subscription/verify`;
  const auth = { authorization: `Bearer ${token}` };
  const body = {
    razorpay_order_id: session.orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signCheckout(session.orderId, paymentId),
  };
  const first = await api(url, { method: 'POST', headers: auth, body });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.data.verified, true);
  assert.equal(first.json.data.phase, 'pending_confirmation');
  assert.notEqual((await subscriptionService.getForTenant(tenant._id.toString())).planId, 'pro');

  await postWebhook(capturedPayload(session.orderId, paymentId), { autoSign: true });
  const sub = await subscriptionService.getForTenant(tenant._id.toString());
  assert.equal(sub.planId, 'pro');
  assert.equal(sub.state, 'active');
  assert.equal(sub.paymentReference, session.orderId);
  const second = await api(url, { method: 'POST', headers: auth, body });
  assert.equal(second.status, 200);
  assert.equal(second.json.data.phase, 'confirmed');
  // Entitlements follow the canonical subscription.
  const ent = await api(`${PREFIX}/tenants/${tenant._id}/entitlements`, { headers: auth });
  assert.equal(ent.status, 200);
  assert.equal(ent.json.data.plan.code, 'pro');
});

test('verify rejects forged signatures and leaves the checkout open', async () => {
  const { tenant, token, session } = await checkoutAsOwner('pro');
  const res = await api(`${PREFIX}/tenants/${tenant._id}/subscription/verify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      razorpay_order_id: session.orderId,
      razorpay_payment_id: 'pay_forged',
      razorpay_signature: 'forgedsignature',
    },
  });
  assert.equal(res.status, 400);
  const txn = await paymentTransactionRepository.findByOrderId(session.orderId);
  assert.equal(txn.status, 'pending');
  const sub = await subscriptionService.getForTenant(tenant._id.toString());
  assert.notEqual(sub.planId, 'pro');
});

test('a captured payment whose amount does not match the order is rejected', async () => {
  const { tenant, session } = await checkoutAsOwner('pro');
  const paymentId = 'pay_verify_mismatch';
  mock.state.payments.set(paymentId, {
    id: paymentId,
    order_id: session.orderId,
    status: 'captured',
    amount: 100, // tampered amount
    currency: 'INR',
    captured: true,
  });
  await postWebhook(capturedPayload(session.orderId, paymentId, 100), { autoSign: true });
  const txn = await paymentTransactionRepository.findByOrderId(session.orderId);
  assert.equal(txn.status, 'failed');
  assert.notEqual((await subscriptionService.getForTenant(tenant._id.toString())).planId, 'pro');
});

test('verify rejects cross-tenant order association', async () => {
  const first = await checkoutAsOwner('pro');
  const second = await seedTenantWithOwner('starter');
  const otherToken = await loginUser(second.ownerUser.email, second.tenant._id.toString());
  const paymentId = 'pay_verify_cross';
  mock.state.payments.set(paymentId, {
    id: paymentId,
    order_id: first.session.orderId,
    status: 'captured',
    amount: 99900,
    currency: 'INR',
    captured: true,
  });
  const res = await api(`${PREFIX}/tenants/${second.tenant._id}/subscription/verify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${otherToken}` },
    body: {
      razorpay_order_id: first.session.orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signCheckout(first.session.orderId, paymentId),
    },
  });
  assert.equal(res.status, 404);
});

/* ------------------------- webhooks ------------------------------------ */

test('webhook payment.captured activates a pending checkout (verified signature)', async () => {
  const { tenant, session } = await checkoutAsOwner('pro');
  const paymentId = 'pay_wh_ok_1';
  providerCaptures(session.orderId, paymentId);
  const res = await postWebhook(capturedPayload(session.orderId, paymentId), { autoSign: true });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(await storedOutcome(session.orderId), 'captured');
  const sub = await subscriptionService.getForTenant(tenant._id.toString());
  assert.equal(sub.planId, 'pro');
  assert.equal(sub.state, 'active');
  const txn = await paymentTransactionRepository.findByOrderId(session.orderId);
  assert.equal(txn.status, 'captured');
});

test('webhook rejects missing and invalid signatures without mutation', async () => {
  const { tenant, session } = await checkoutAsOwner('pro');
  const payload = capturedPayload(session.orderId, 'pay_wh_bad');
  providerCaptures(session.orderId, 'pay_wh_bad');
  const missing = await postWebhook(payload, {});
  assert.equal(missing.status, 401);
  const invalid = await postWebhook(payload, { signature: 'invalid' });
  assert.equal(invalid.status, 401);
  const txn = await paymentTransactionRepository.findByOrderId(session.orderId);
  assert.equal(txn.status, 'pending');
  const sub = await subscriptionService.getForTenant(tenant._id.toString());
  assert.equal(sub.planId, 'starter');
  assert.equal(await WebhookEvent.countDocuments({}), 0);
});

test('webhook duplicate delivery is idempotent', async () => {
  const { session } = await checkoutAsOwner('pro');
  const payload = capturedPayload(session.orderId, 'pay_wh_dup');
  providerCaptures(session.orderId, 'pay_wh_dup');
  const first = await postWebhook(payload, { autoSign: true });
  const second = await postWebhook(payload, { autoSign: true });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.json.reason, 'duplicate_delivery');
  const txn = await paymentTransactionRepository.findByOrderId(session.orderId);
  assert.equal(txn.status, 'captured');
});

test('webhook out-of-order failure after capture does not regress', async () => {
  const { tenant, session } = await checkoutAsOwner('pro');
  providerCaptures(session.orderId, 'pay_wh_ooo');
  await postWebhook(capturedPayload(session.orderId, 'pay_wh_ooo'), { autoSign: true });
  const failed = await postWebhook(
    {
      event: 'payment.failed',
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: 'pay_wh_ooo', order_id: session.orderId, status: 'failed' } } },
    },
    { autoSign: true },
  );
  assert.equal(failed.status, 200);
  const txn = await paymentTransactionRepository.findByOrderId(session.orderId);
  assert.equal(txn.status, 'captured');
  const sub = await subscriptionService.getForTenant(tenant._id.toString());
  assert.equal(sub.planId, 'pro');
  assert.equal(sub.state, 'active');
});

test('webhook unsupported events and unknown orders are acknowledged without mutation', async () => {
  const { tenant, session } = await checkoutAsOwner('pro');
  const unsupported = await postWebhook(
    { event: 'payment.dispute.created', payload: { payment: { entity: { id: 'pay_x', order_id: session.orderId } } } },
    { autoSign: true },
  );
  assert.equal(unsupported.status, 200);
  assert.equal(unsupported.json.reason, 'unsupported_event');
  assert.equal(await storedOutcome(session.orderId), 'unsupported_event');
  const unknown = await postWebhook(capturedPayload('order_unknown_xyz', 'pay_unknown'), { autoSign: true });
  assert.equal(unknown.status, 200);
  assert.equal(await storedOutcome('order_unknown_xyz'), 'unknown_order');
  const sub = await subscriptionService.getForTenant(tenant._id.toString());
  assert.equal(sub.planId, 'starter');
});

test('webhook refund marks refunded but retains access (documented policy)', async () => {
  const { tenant, session } = await checkoutAsOwner('pro');
  providerCaptures(session.orderId, 'pay_wh_ref');
  await postWebhook(capturedPayload(session.orderId, 'pay_wh_ref'), { autoSign: true });
  const refunded = await postWebhook(
    {
      event: 'refund.processed',
      created_at: Math.floor(Date.now() / 1000),
      payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_wh_ref', amount: 99900 } } },
    },
    { autoSign: true },
  );
  // billing: a refund entity without order_id is correlated by payment id.
  assert.equal(refunded.status, 200);
  assert.equal((await paymentTransactionRepository.findByOrderId(session.orderId)).status, 'refunded');
  // Refund path is exercised directly for order correlation:
  const direct = await postWebhook(
    {
      event: 'refund.processed',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        refund: { entity: { id: 'rfnd_2', order_id: session.orderId, payment_id: 'pay_wh_ref', amount: 99900 } },
      },
    },
    { autoSign: true },
  );
  assert.equal(direct.status, 200);
  assert.equal(await storedOutcome(session.orderId), 'already_refunded');
  const txn = await paymentTransactionRepository.findByOrderId(session.orderId);
  assert.equal(txn.status, 'refunded');
  const sub = await subscriptionService.getForTenant(tenant._id.toString());
  assert.equal(sub.planId, 'pro');
  assert.equal(sub.state, 'active');
});

/* ------------------------- lifecycle guards ---------------------------- */

test('verified capture refuses to activate a suspended tenant', async () => {
  const { tenant, token, session } = await checkoutAsOwner('pro');
  await Tenant.updateOne({ _id: tenant._id }, { $set: { status: 'suspended' } });
  const paymentId = 'pay_wh_susp';
  providerCaptures(session.orderId, paymentId);
  const res = await postWebhook(capturedPayload(session.orderId, paymentId), { autoSign: true });
  assert.equal(res.status, 200);
  assert.equal(await storedOutcome(session.orderId), 'refused');
  const sub = await subscriptionService.getForTenant(tenant._id.toString());
  assert.notEqual(sub.planId, 'pro');
});

test('a failed payment never changes a running prepaid term (history only)', async () => {
  const { tenant } = await seedTenantWithOwner('starter');
  const tenantId = tenant._id.toString();
  await subscriptionService.createForTenant({
    tenantId,
    planId: 'pro',
    state: 'active',
    actor: { type: 'system', id: 'test' },
    by: 'test',
    reason: 'test setup',
    paymentProvider: 'razorpay',
    paymentReference: 'order_match_me',
  });
  const result = await billingLifecycle.applyFailure({
    tenantId,
    providerRef: 'order_match_me',
    reason: 'card declined',
    actor: { type: 'system', id: 'test' },
  });
  assert.equal(result.applied, true);
  assert.equal(result.note, 'recorded');
  const sub = await subscriptionService.getForTenant(tenantId);
  assert.equal(sub.state, 'active');
  assert.equal(sub.planId, 'pro');
});

test('subscriptions under an administrative hold are never activated by money events', async () => {
  const { tenant } = await seedTenantWithOwner('starter');
  const tenantId = tenant._id.toString();
  await subscriptionService.createForTenant({
    tenantId,
    planId: 'starter',
    state: 'active',
    actor: { type: 'system', id: 'test' },
    by: 'test',
    reason: 'test setup',
  });
  const held = await subscriptionService.setState({
    tenantId,
    state: 'restricted',
    actor: { type: 'admin', id: 'test' },
    by: 'test',
    reason: 'compliance hold',
  });
  assert.equal(held.adminHold, true);
  await assert.rejects(
    subscriptionService.applyPaidTerm({ tenantId, planId: 'pro', transactionId: 'txn_x', providerRef: 'order_x', actor: { type: 'system', id: 'test' } }),
    /administrative hold/,
  );
});

/* ------------------------- reconciliation ------------------------------ */

test('reconcile captures paid-but-unwebhooked orders; skips unpaid; 501 when disabled', async () => {
  const { tenant, session } = await checkoutAsOwner('pro');
  const stored = mock.state.orders.get(session.orderId);
  stored.status = 'paid';
  stored.amount_paid = 99900;
  stored.amount_due = 0;
  providerCaptures(session.orderId, 'pay_recon_1');
  // billing: a new checkout is first checked a few minutes after creation.
  const startedAt = Date.now();
  clock.set(new Date(startedAt + 10 * 60 * 1000));
  await makeAdmin('recon@example.com', 'platform', ['billing.subscriptions.override']);
  const adminToken = await loginAdmin('recon@example.com');
  const res = await api(`${PREFIX}/admin/subscriptions/reconcile?limit=10`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.captured, 1);
  const sub = await subscriptionService.getForTenant(tenant._id.toString());
  assert.equal(sub.planId, 'pro');
  // Second run is a no-op (idempotent).
  const again = await api(`${PREFIX}/admin/subscriptions/reconcile?limit=10`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(again.json.data.captured, 0);

  // Unpaid order is skipped, left pending.
  const unpaid = await checkoutAsOwner('pro');
  clock.set(new Date(startedAt + 30 * 60 * 1000));
  const skipped = await api(`${PREFIX}/admin/subscriptions/reconcile?limit=10`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(skipped.json.data.captured, 0);
  assert.equal(skipped.json.data.skipped, 1);
  const stillPending = await paymentTransactionRepository.findByOrderId(unpaid.session.orderId);
  assert.equal(stillPending.status, 'pending');

  __clearTestProviders();
  const disabled = await api(`${PREFIX}/admin/subscriptions/reconcile?limit=10`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(disabled.status, 501);
});

test('reconcile requires override permission', async () => {
  await makeAdmin('reconview@example.com', 'platform', ['billing.subscriptions.view']);
  const token = await loginAdmin('reconview@example.com');
  const res = await api(`${PREFIX}/admin/subscriptions/reconcile?limit=10`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 403);
});

/* ------------------------- admin visibility ---------------------------- */

test('admin can inspect transactions and webhooks (redacted, permission-gated)', async () => {
  const { tenant, session } = await checkoutAsOwner('pro');
  providerCaptures(session.orderId, 'pay_wh_admin');
  await postWebhook(capturedPayload(session.orderId, 'pay_wh_admin'), { autoSign: true });
  await makeAdmin('billview@example.com', 'platform', ['billing.subscriptions.view']);
  const token = await loginAdmin('billview@example.com');
  const auth = { authorization: `Bearer ${token}` };
  const txns = await api(`${PREFIX}/admin/subscriptions/${tenant._id}/transactions`, { headers: auth });
  assert.equal(txns.status, 200);
  assert.equal(txns.json.data.length, 1);
  assert.equal(txns.json.data[0].providerOrderId, session.orderId);
  assert.ok(!('providerSecret' in txns.json.data[0]));
  const hooks = await api(`${PREFIX}/admin/subscriptions/${tenant._id}/webhooks`, { headers: auth });
  assert.equal(hooks.status, 200);
  assert.ok(hooks.json.data.length >= 1);
  assert.ok(!JSON.stringify(hooks.json.data).includes(TEST_WEBHOOK_SECRET));
});
