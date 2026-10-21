/**
 * Billing (roadmap 3.1) - prepaid-term lifecycle, provider-confirmed
 * upgrades, webhook dedupe/forward-only processing, safe capture,
 * reconciliation and feature entitlements.
 *
 * Runs against the REAL Express app, services and Mongo (memory server).
 * Only the payment provider boundary is faked (`__setTestProvider`); no
 * network, no real Razorpay. Time-dependent behaviour uses the injectable
 * clock (`utils/clock.js`).
 */

import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { startHttp, stopHttp, api } from '../helpers/http.js';
import { entitleTenant } from '../helpers/billing.js';
import * as emailService from '../../src/services/email.service.js';
import tenantService from '../../src/services/tenant.service.js';
import invitationService from '../../src/services/tenantInvitation.service.js';
import planService from '../../src/services/plan.service.js';
import subscriptionService from '../../src/services/subscription.service.js';
import entitlementService from '../../src/services/entitlement.service.js';
import billingLifecycle from '../../src/services/billingLifecycle.service.js';
import billingReconcile from '../../src/services/billingReconcile.service.js';
import billingWebhookService from '../../src/services/billingWebhook.service.js';
import { setDispatchOnEnqueue } from '../../src/services/outbox.service.js';
import paymentTransactionRepository from '../../src/repositories/paymentTransaction.repository.js';
import { PaymentTransaction } from '../../src/models/PaymentTransaction.js';
import { Subscription } from '../../src/models/Subscription.js';
import { SubscriptionHistory } from '../../src/models/SubscriptionHistory.js';
import { OutboundEmail } from '../../src/models/OutboundEmail.js';
import { Tenant } from '../../src/models/Tenant.js';
import WebhookEvent from '../../src/models/WebhookEvent.js';
import { MasterData } from '../../src/models/MasterData.js';
import ApiError from '../../src/utils/ApiError.js';
import clock from '../../src/utils/clock.js';
import {
  hmacHex,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  normalizeWebhookEvent,
  __setTestProvider,
  __clearTestProviders,
} from '../../src/services/paymentProvider.adapter.js';
import { __setTestMapping, __clearTestMapping } from '../../src/services/billingPricing.service.js';
import { requireFeature } from '../../src/middleware/requireFeature.middleware.js';

const PASSWORD = 'BillingPassword123!';
const PREFIX = '/api/v1';
const KEY_SECRET = 'test_key_secret_billing';
const WEBHOOK_SECRET = 'test_webhook_secret_billing';
const DAY = 86400000;
const MAPPING = Object.freeze({
  starter: { month: { amountMinor: 49900, currency: 'INR' }, year: { amountMinor: 499000, currency: 'INR' } },
  pro: { month: { amountMinor: 99900, currency: 'INR' }, year: { amountMinor: 999000, currency: 'INR' } },
});

/* ---------------------------- fake provider ---------------------------- */

function makeProvider() {
  const state = { orders: new Map(), payments: new Map(), seq: 0 };
  const calls = { createOrder: 0, fetchOrder: 0, fetchPayment: 0, fetchOrderPayments: 0 };
  return {
    state,
    calls,
    name: 'razorpay',
    isImplemented: true,
    environment: 'test',
    keyId: 'rzp_test_public_billing',
    async createOrder({ amountMinor, currency, receipt }) {
      calls.createOrder += 1;
      const id = `order_${++state.seq}_${randomBytes(3).toString('hex')}`;
      const order = { id, amount: amountMinor, currency, receipt, status: 'created', amount_paid: 0, amount_due: amountMinor };
      state.orders.set(id, order);
      return { ...order };
    },
    async fetchOrder(orderId) {
      calls.fetchOrder += 1;
      const order = state.orders.get(orderId);
      if (!order) throw ApiError.notFound('order not found');
      return { ...order };
    },
    async fetchPayment(paymentId) {
      calls.fetchPayment += 1;
      const payment = state.payments.get(paymentId);
      if (!payment) throw ApiError.notFound('payment not found');
      return { ...payment };
    },
    async fetchOrderPayments(orderId) {
      calls.fetchOrderPayments += 1;
      return [...state.payments.values()].filter((p) => p.order_id === orderId).map((p) => ({ ...p }));
    },
    verifyCheckoutSignature({ orderId, paymentId, signature }) {
      return verifyCheckoutSignature({ orderId, paymentId, signature, keySecret: KEY_SECRET });
    },
    verifyWebhookSignature(rawBody, signature) {
      return verifyWebhookSignature({ rawBody, signature, webhookSecret: WEBHOOK_SECRET });
    },
    normalizeWebhookEvent,
    /** Test helper: the provider records a payment for an order. */
    pay(orderId, { status = 'captured', amount, currency = 'INR', id = `pay_${randomBytes(4).toString('hex')}` } = {}) {
      const order = state.orders.get(orderId);
      const payment = {
        id,
        order_id: orderId,
        status,
        amount: amount ?? order?.amount,
        currency,
        captured: status === 'captured',
      };
      state.payments.set(id, payment);
      if (order && status === 'captured') {
        order.status = 'paid';
        order.amount_paid = order.amount;
        order.amount_due = 0;
      }
      return payment;
    },
  };
}

let provider;

before(async () => {
  await startMongo();
  await startHttp();
  setDispatchOnEnqueue(false);
});

beforeEach(async () => {
  await resetMongo();
  clock.reset();
  __clearTestProviders();
  __setTestMapping({ ...MAPPING });
  provider = makeProvider();
  __setTestProvider('razorpay', provider);
  await planService.ensureDefaults('test', { mapping: MAPPING });
});

afterEach(async () => {
  await billingWebhookService.waitForIdle();
  clock.reset();
});

after(async () => {
  __clearTestProviders();
  __clearTestMapping();
  setDispatchOnEnqueue(true);
  await emailService.close();
  await stopHttp();
  await stopMongo();
});

/* ------------------------------- fixtures ------------------------------- */

async function captureInviteToken(fn) {
  const sink = [];
  emailService.captureInto(sink);
  try {
    await fn();
  } finally {
    emailService.stopCapture();
  }
  const link = sink.map((m) => m.text).join('\n').match(/https?:\/\/[^\s]+/u)?.[0];
  return link ? new URL(link).searchParams.get('token') : null;
}

async function login(slug, email) {
  const res = await api(`${PREFIX}/auth/login`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': slug },
    body: { email, password: PASSWORD },
  });
  assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.json)}`);
  return { authorization: `Bearer ${res.json.data.accessToken}` };
}

/** An initialised workspace (real onboarding) whose Owner can log in. */
async function workspace({ planId } = {}) {
  const email = `owner-${randomBytes(4).toString('hex')}@example.com`;
  let result;
  const token = await captureInviteToken(async () => {
    result = await tenantService.create({
      tenant: { name: `Billing ${randomBytes(3).toString('hex')}`, ...(planId ? { planId } : {}) },
      owner: { email, name: 'Owner' },
      initialize: true,
      by: 'platform-admin',
    });
  });
  await invitationService.accept({ token, name: 'Owner', password: PASSWORD });
  const auth = await login(result.tenant.slug, email);
  return { tenantId: String(result.tenant._id), slug: result.tenant.slug, email, auth };
}

async function member(ws, roleName) {
  const email = `${roleName.toLowerCase()}-${randomBytes(4).toString('hex')}@example.com`;
  const token = await captureInviteToken(() => invitationService.create({
    tenantId: ws.tenantId, email, name: roleName, roleName, invitedBy: 'platform-admin',
  }));
  await invitationService.accept({ token, name: roleName, password: PASSWORD });
  return { email, auth: await login(ws.slug, email) };
}

async function checkout(ws, planId = 'pro', interval = 'month') {
  const res = await api(`${PREFIX}/tenants/${ws.tenantId}/subscription/checkout`, {
    method: 'POST',
    headers: ws.auth,
    body: { planId, interval },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.data;
}

function eventPayload(event, { orderId, paymentId, amount = 99900, currency = 'INR', status }) {
  return {
    event,
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: { entity: { id: paymentId, order_id: orderId, amount, currency, status: status ?? event.split('.')[1] } },
    },
  };
}

async function postWebhook(payload, { eventId = `evt_${randomBytes(6).toString('hex')}`, signature } = {}) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = signature === undefined ? hmacHex(WEBHOOK_SECRET, raw) : signature;
  const headers = { 'content-type': 'application/json', 'x-razorpay-event-id': eventId };
  if (sig) headers['x-razorpay-signature'] = sig;
  const res = await api(`${PREFIX}/billing/webhook`, { method: 'POST', headers, body: payload });
  await billingWebhookService.waitForIdle();
  return res;
}

async function sub(ws) {
  return subscriptionService.getForTenant(ws.tenantId);
}

/* ------------------------ new workspace: free plan ---------------------- */

test('a new workspace is provisioned on the free plan (not starter)', async () => {
  const ws = await workspace();
  const s = await sub(ws);
  assert.equal(s.planId, 'free');
  assert.equal(s.state, 'active');
  const ent = await entitlementService.resolveEffective(ws.tenantId);
  assert.equal(ent.plan.code, 'free');
  assert.equal(ent.features.embedding, false);
});

test('a tenant without a subscription row resolves the free plan', async () => {
  const tenant = await Tenant.create({ name: 'No sub', slug: `nosub-${randomBytes(3).toString('hex')}`, status: 'active', planId: 'pro' });
  const ent = await entitlementService.resolveEffective(String(tenant._id));
  assert.equal(ent.plan.code, 'free');
  assert.equal(ent.source, 'fallback');
});

test('a plan trial is provisioned only when the plan defines trialDays', async () => {
  const ws = await workspace({ planId: 'pro' });
  const s = await sub(ws);
  assert.equal(s.planId, 'pro');
  assert.equal(s.state, 'trialing');
  assert.ok(new Date(s.trialEndsAt).getTime() > Date.now() + 13 * DAY);
  // Free defines no trial: the free plan is simply active.
  const free = await workspace({ planId: 'free' });
  assert.equal((await sub(free)).state, 'active');
  // Trial end moves the workspace to the free plan (computed and persisted).
  clock.set(new Date(Date.now() + 15 * DAY));
  assert.equal((await entitlementService.resolveEffective(ws.tenantId)).plan.code, 'free');
  await billingLifecycle.runLifecycleSweep();
  assert.equal((await sub(ws)).planId, 'free');
});

test('plan codes match exactly (no substring / regex resolution)', async () => {
  await planService.create({
    code: 'enterprise_pro',
    name: 'Pro Max',
    data: { status: 'active', tier: 5, features: { embedding: true }, limits: {} },
  }, 'test');
  const pro = await planService.getByCode('pro');
  assert.equal(pro.code, 'pro');
  assert.equal(await planService.getByCode('.'), null);
  assert.equal(await planService.getByCode('pr'), null);
  assert.equal(await planService.getByCode('ENTERPRISE_PRO'), null);
});

/* --------------------- checkout: provider-confirmed only ----------------- */

test('upgrade happens only after the provider-confirmed capture (verify never grants)', async () => {
  const ws = await workspace();
  const session = await checkout(ws, 'pro', 'month');
  assert.equal(session.amountMinor, 99900);
  assert.equal(session.interval, 'month');
  assert.equal(session.environment, 'test');
  assert.equal((await sub(ws)).planId, 'free', 'creating an order grants nothing');

  const payment = provider.pay(session.orderId);
  const verify = await api(`${PREFIX}/tenants/${ws.tenantId}/subscription/verify`, {
    method: 'POST',
    headers: ws.auth,
    body: {
      razorpay_order_id: session.orderId,
      razorpay_payment_id: payment.id,
      razorpay_signature: hmacHex(KEY_SECRET, `${session.orderId}|${payment.id}`),
    },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  assert.equal(verify.json.data.phase, 'pending_confirmation');
  assert.equal((await sub(ws)).planId, 'free', 'the browser callback alone grants nothing');

  const wh = await postWebhook(eventPayload('payment.captured', { orderId: session.orderId, paymentId: payment.id }));
  assert.equal(wh.status, 200);
  const after = await sub(ws);
  assert.equal(after.planId, 'pro');
  assert.equal(after.state, 'active');
  assert.equal(after.billingInterval, 'month');
  assert.ok(provider.calls.fetchPayment >= 1, 'capture confirmed by a server-side payment fetch');

  const status = await api(`${PREFIX}/tenants/${ws.tenantId}/subscription/checkout/${session.orderId}`, { headers: ws.auth });
  assert.equal(status.status, 200);
  assert.equal(status.json.data.phase, 'confirmed');
  assert.equal(status.json.data.transaction.applied, true);
});

test('verify rejects a forged signature and does not touch the plan', async () => {
  const ws = await workspace();
  const session = await checkout(ws);
  const res = await api(`${PREFIX}/tenants/${ws.tenantId}/subscription/verify`, {
    method: 'POST',
    headers: ws.auth,
    body: { razorpay_order_id: session.orderId, razorpay_payment_id: 'pay_x', razorpay_signature: 'forged' },
  });
  assert.equal(res.status, 400);
  assert.equal((await sub(ws)).planId, 'free');
});

test('workspace routes never write a paid planId; checkout validates the interval', async () => {
  const ws = await workspace();
  const change = await api(`${PREFIX}/tenants/${ws.tenantId}/subscription/change-plan`, {
    method: 'POST', headers: ws.auth, body: { planId: 'pro' },
  });
  assert.equal(change.status, 403);
  const bad = await api(`${PREFIX}/tenants/${ws.tenantId}/subscription/checkout`, {
    method: 'POST', headers: ws.auth, body: { planId: 'pro', interval: 'weekly' },
  });
  assert.equal(bad.status, 422);
  const free = await api(`${PREFIX}/tenants/${ws.tenantId}/subscription/checkout`, {
    method: 'POST', headers: ws.auth, body: { planId: 'free' },
  });
  assert.equal(free.status, 400);
  assert.equal((await sub(ws)).planId, 'free');
});

test('annual term: a yearly checkout buys twelve months', async () => {
  const ws = await workspace();
  const session = await checkout(ws, 'pro', 'year');
  assert.equal(session.amountMinor, 999000);
  const payment = provider.pay(session.orderId);
  await postWebhook(eventPayload('payment.captured', { orderId: session.orderId, paymentId: payment.id, amount: 999000 }));
  const s = await sub(ws);
  assert.equal(s.planId, 'pro');
  const months = (new Date(s.currentPeriodEnd) - new Date(s.currentPeriodStart)) / DAY;
  assert.ok(months >= 364 && months <= 366, `term length ${months} days`);
});

/* ------------------------------ webhooks -------------------------------- */

test('duplicate webhook event (same x-razorpay-event-id) is processed once', async () => {
  const ws = await workspace();
  const session = await checkout(ws);
  const payment = provider.pay(session.orderId);
  const payload = eventPayload('payment.captured', { orderId: session.orderId, paymentId: payment.id });
  const first = await postWebhook(payload, { eventId: 'evt_dup_1' });
  const firstEnd = (await sub(ws)).currentPeriodEnd;
  const second = await postWebhook(payload, { eventId: 'evt_dup_1' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate, true);
  assert.equal(await WebhookEvent.countDocuments({ eventId: 'evt_dup_1' }), 1);
  const stored = await WebhookEvent.findOne({ eventId: 'evt_dup_1' }).lean();
  assert.equal(stored.deliveries, 2);
  assert.equal(stored.status, 'processed');
  assert.equal(await SubscriptionHistory.countDocuments({ tenantId: ws.tenantId, type: 'subscription.payment_captured' }), 1);
  assert.equal(String((await sub(ws)).currentPeriodEnd), String(firstEnd), 'the term was applied once');
  // A different event id for the same capture is still applied only once.
  await postWebhook(eventPayload('order.paid', { orderId: session.orderId, paymentId: payment.id }), { eventId: 'evt_dup_2' });
  assert.equal(await SubscriptionHistory.countDocuments({ tenantId: ws.tenantId, type: 'subscription.payment_captured' }), 1);
});

test('webhook signature is verified over the raw body; bad or missing signatures store nothing', async () => {
  const ws = await workspace();
  const session = await checkout(ws);
  const payload = eventPayload('payment.captured', { orderId: session.orderId, paymentId: 'pay_sig' });
  assert.equal((await postWebhook(payload, { signature: null })).status, 401);
  assert.equal((await postWebhook(payload, { signature: 'deadbeef' })).status, 401);
  assert.equal(await WebhookEvent.countDocuments({}), 0);
  assert.equal((await sub(ws)).planId, 'free');
});

test('out-of-order events never move state backwards', async () => {
  const ws = await workspace();
  const session = await checkout(ws);
  const payment = provider.pay(session.orderId);
  await postWebhook(eventPayload('payment.captured', { orderId: session.orderId, paymentId: payment.id }));
  // Late deliveries of earlier / failure events after the capture.
  await postWebhook(eventPayload('payment.authorized', { orderId: session.orderId, paymentId: payment.id }));
  await postWebhook(eventPayload('payment.failed', { orderId: session.orderId, paymentId: payment.id }));
  const txn = await paymentTransactionRepository.findByOrderId(session.orderId);
  assert.equal(txn.status, 'captured');
  const s = await sub(ws);
  assert.equal(s.planId, 'pro');
  assert.equal(s.state, 'active');
});

test('payment.failed then payment.captured on the same order still upgrades', async () => {
  const ws = await workspace();
  const session = await checkout(ws);
  await postWebhook(eventPayload('payment.failed', { orderId: session.orderId, paymentId: 'pay_declined' }));
  assert.equal((await paymentTransactionRepository.findByOrderId(session.orderId)).status, 'failed');
  const payment = provider.pay(session.orderId);
  await postWebhook(eventPayload('payment.captured', { orderId: session.orderId, paymentId: payment.id }));
  assert.equal((await paymentTransactionRepository.findByOrderId(session.orderId)).status, 'captured');
  assert.equal((await sub(ws)).planId, 'pro');
});

test('an authorized-only payment grants no access', async () => {
  const ws = await workspace();
  const session = await checkout(ws);
  const payment = provider.pay(session.orderId, { status: 'authorized' });
  await postWebhook(eventPayload('payment.authorized', { orderId: session.orderId, paymentId: payment.id }));
  assert.equal((await paymentTransactionRepository.findByOrderId(session.orderId)).status, 'authorized');
  assert.equal((await sub(ws)).planId, 'free');
  // Even a "captured" event is not trusted while the provider says authorized.
  await postWebhook(eventPayload('payment.captured', { orderId: session.orderId, paymentId: payment.id }));
  assert.equal((await sub(ws)).planId, 'free');
  assert.equal(await entitlementService.hasFeature({ tenantId: ws.tenantId, feature: 'embedding' }), false);
});

test('amount or currency mismatch against the order is rejected', async () => {
  const ws = await workspace();
  const session = await checkout(ws);
  const short = provider.pay(session.orderId, { amount: 100 });
  await postWebhook(eventPayload('payment.captured', { orderId: session.orderId, paymentId: short.id, amount: 100 }));
  const txn = await paymentTransactionRepository.findByOrderId(session.orderId);
  assert.equal(txn.status, 'failed');
  assert.equal(txn.failureReason, 'payment_amount_mismatch');
  assert.equal((await sub(ws)).planId, 'free');

  const other = await workspace();
  const second = await checkout(other);
  const usd = provider.pay(second.orderId, { currency: 'USD' });
  await postWebhook(eventPayload('payment.captured', { orderId: second.orderId, paymentId: usd.id, currency: 'USD' }));
  assert.equal((await sub(other)).planId, 'free');
});

test('a capture whose application fails is retried from the stored event and applied once', async () => {
  const ws = await workspace();
  const session = await checkout(ws);
  const payment = provider.pay(session.orderId);
  const original = subscriptionService.applyPaidTerm;
  let calls = 0;
  subscriptionService.applyPaidTerm = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('transient database error');
    return original(...args);
  };
  try {
    await postWebhook(eventPayload('payment.captured', { orderId: session.orderId, paymentId: payment.id }), { eventId: 'evt_retry' });
    const txn = await paymentTransactionRepository.findByOrderId(session.orderId);
    assert.equal(txn.status, 'captured');
    assert.equal(txn.appliedAt, null, 'captured but not applied yet');
    assert.equal((await sub(ws)).planId, 'free');
    const stored = await WebhookEvent.findOne({ eventId: 'evt_retry' }).lean();
    assert.equal(stored.status, 'received');
    // The retry sweep (run by the reconcile job) re-drives it later.
    const drained = await billingWebhookService.drainDue({ now: new Date(Date.now() + 10 * 60 * 1000) });
    assert.equal(drained.webhooksProcessed, 1);
  } finally {
    subscriptionService.applyPaidTerm = original;
  }
  const txn = await paymentTransactionRepository.findByOrderId(session.orderId);
  assert.ok(txn.appliedAt);
  assert.equal((await sub(ws)).planId, 'pro');
  assert.equal(await SubscriptionHistory.countDocuments({ tenantId: ws.tenantId, type: 'subscription.payment_captured' }), 1);
});

test('a suspended tenant is never activated; reconcile applies the paid term once reinstated', async () => {
  const ws = await workspace();
  const session = await checkout(ws);
  const payment = provider.pay(session.orderId);
  await Tenant.updateOne({ _id: ws.tenantId }, { $set: { status: 'suspended' } });
  await postWebhook(eventPayload('payment.captured', { orderId: session.orderId, paymentId: payment.id }), { eventId: 'evt_susp' });
  assert.equal((await WebhookEvent.findOne({ eventId: 'evt_susp' }).lean()).outcome, 'refused');
  assert.equal((await sub(ws)).planId, 'free');
  await Tenant.updateOne({ _id: ws.tenantId }, { $set: { status: 'active' } });
  const result = await billingReconcile.reconcilePending({ now: new Date(Date.now() + 2 * 60 * 1000) });
  assert.equal(result.reapplied, 1);
  assert.equal((await sub(ws)).planId, 'pro');
});

/* ----------------------------- renewals --------------------------------- */

test('renewing the same plan extends the prepaid term from its end', async () => {
  const ws = await workspace();
  const first = await checkout(ws);
  await postWebhook(eventPayload('payment.captured', { orderId: first.orderId, paymentId: provider.pay(first.orderId).id }));
  const end1 = new Date((await sub(ws)).currentPeriodEnd);
  const second = await checkout(ws);
  assert.notEqual(second.orderId, first.orderId);
  await postWebhook(eventPayload('payment.captured', { orderId: second.orderId, paymentId: provider.pay(second.orderId).id }));
  const end2 = new Date((await sub(ws)).currentPeriodEnd);
  const days = (end2 - end1) / DAY;
  assert.ok(days >= 28 && days <= 31, `renewal added ${days} days`);
});

/* ----------------------------- downgrades ------------------------------- */

async function onPaidTerm(ws, planId = 'pro') {
  const session = await checkout(ws, planId);
  await postWebhook(eventPayload('payment.captured', {
    orderId: session.orderId,
    paymentId: provider.pay(session.orderId).id,
    amount: session.amountMinor,
  }));
  const s = await sub(ws);
  assert.equal(s.planId, planId);
  return s;
}

test('a downgrade is scheduled and applies at the period end', async () => {
  const ws = await workspace();
  const paid = await onPaidTerm(ws, 'pro');
  const res = await api(`${PREFIX}/tenants/${ws.tenantId}/subscription/change-plan`, {
    method: 'POST', headers: ws.auth, body: { planId: 'free' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.planId, 'pro', 'the paid term keeps running');
  assert.equal(res.json.data.scheduledChange.planId, 'free');
  assert.equal((await entitlementService.resolveEffective(ws.tenantId)).plan.code, 'pro');

  clock.set(new Date(new Date(paid.currentPeriodEnd).getTime() + 60 * 1000));
  assert.equal((await entitlementService.resolveEffective(ws.tenantId)).plan.code, 'free', 'computed at the period end');
  const swept = await billingLifecycle.runLifecycleSweep();
  assert.equal(swept.scheduledApplied, 1);
  const s = await sub(ws);
  assert.equal(s.planId, 'free');
  assert.equal(s.state, 'active');
  assert.equal(s.scheduledChange, null);
});

test('buying a lower-tier term while on a higher one queues it for the period end', async () => {
  const ws = await workspace();
  const paid = await onPaidTerm(ws, 'pro');
  const lower = await checkout(ws, 'starter');
  await postWebhook(eventPayload('payment.captured', {
    orderId: lower.orderId, paymentId: provider.pay(lower.orderId).id, amount: lower.amountMinor,
  }));
  const queued = await sub(ws);
  assert.equal(queued.planId, 'pro');
  assert.equal(queued.scheduledChange.planId, 'starter');
  clock.set(new Date(new Date(paid.currentPeriodEnd).getTime() + 60 * 1000));
  await billingLifecycle.runLifecycleSweep();
  const s = await sub(ws);
  assert.equal(s.planId, 'starter');
  assert.ok(new Date(s.currentPeriodEnd) > new Date(paid.currentPeriodEnd));
});

/* --------------------- expiry, grace, restriction ----------------------- */

test('expiry -> past_due -> restricted with a fixed clock, with reminders sent once', async () => {
  const ws = await workspace();
  const paid = await onPaidTerm(ws, 'pro');
  const end = new Date(paid.currentPeriodEnd).getTime();
  const graceDays = (await planService.getByCode('pro')).data.graceDays;

  // 7 days before the end: one reminder through the outbox.
  clock.set(new Date(end - 6.5 * DAY));
  const early = await billingLifecycle.runLifecycleSweep();
  assert.equal(early.remindersQueued, 1);
  const again = await billingLifecycle.runLifecycleSweep();
  assert.equal(again.remindersQueued, 0, 'the same reminder is never queued twice');
  // 1 day before: the second (more urgent) reminder.
  clock.set(new Date(end - 0.5 * DAY));
  assert.equal((await billingLifecycle.runLifecycleSweep()).remindersQueued, 1);
  const reminders = await OutboundEmail.find({ tenantId: ws.tenantId, template: 'billing.renewal_reminder' }).lean();
  assert.equal(reminders.length, 2);

  // Term over: past_due (grace), the plan still applies.
  clock.set(new Date(end + 60 * 60 * 1000));
  const lapsed = await entitlementService.resolveEffective(ws.tenantId);
  assert.equal(lapsed.state, 'past_due', 'computed on read before the job runs');
  assert.equal(lapsed.writeBlocked, false);
  const step1 = await billingLifecycle.runLifecycleSweep();
  assert.equal(step1.pastDue, 1);
  const pastDue = await sub(ws);
  assert.equal(pastDue.state, 'past_due');
  assert.ok(pastDue.graceEndsAt);
  assert.equal(await OutboundEmail.countDocuments({ tenantId: ws.tenantId, template: 'billing.payment_overdue' }), 1);
  assert.equal(await entitlementService.hasFeature({ tenantId: ws.tenantId, feature: 'embedding' }), true);

  // Grace over: restricted, writes and paid features blocked.
  clock.set(new Date(end + (graceDays + 1) * DAY));
  const blocked = await entitlementService.resolveEffective(ws.tenantId);
  assert.equal(blocked.state, 'restricted');
  assert.equal(blocked.writeBlocked, true);
  const step2 = await billingLifecycle.runLifecycleSweep();
  assert.equal(step2.restricted, 1);
  const restricted = await sub(ws);
  assert.equal(restricted.state, 'restricted');
  assert.equal(restricted.adminHold, false);
  assert.equal(await entitlementService.hasFeature({ tenantId: ws.tenantId, feature: 'embedding' }), false);

  // A new paid term lifts a lifecycle restriction.
  const renewal = await checkout(ws, 'pro');
  await postWebhook(eventPayload('payment.captured', { orderId: renewal.orderId, paymentId: provider.pay(renewal.orderId).id }));
  const back = await sub(ws);
  assert.equal(back.state, 'active');
  assert.ok(new Date(back.currentPeriodEnd).getTime() > clock.now().getTime() + 27 * DAY);
});

test('the lifecycle job runs through the scheduler under the lock and records a JobRun', async () => {
  const { runJob, getRegisteredJobs, resetSchedulerForTests } = await import('../../src/jobs/scheduler.js');
  const { JobRun } = await import('../../src/models/JobRun.js');
  resetSchedulerForTests();
  const job = (await import('../../src/jobs/billingLifecycle.job.js')).default;
  assert.ok(getRegisteredJobs().some((j) => j.name === 'billing-lifecycle'));
  const ws = await workspace();
  const paid = await onPaidTerm(ws, 'pro');
  clock.set(new Date(new Date(paid.currentPeriodEnd).getTime() + 60 * 1000));
  const result = await runJob(job, { trigger: 'manual' });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.counts.pastDue, 1);
  const run = await JobRun.findOne({ job: 'billing-lifecycle' }).lean();
  assert.equal(run.status, 'succeeded');
});

test('canceled at period end becomes expired; an immediate cancel is write-blocked at once', async () => {
  const ws = await workspace();
  const paid = await onPaidTerm(ws, 'pro');
  const res = await api(`${PREFIX}/tenants/${ws.tenantId}/subscription/cancel`, {
    method: 'POST', headers: ws.auth, body: { reason: 'leaving' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.access.state, 'canceled');
  assert.equal((await entitlementService.resolveEffective(ws.tenantId)).writeBlocked, false);
  clock.set(new Date(new Date(paid.currentPeriodEnd).getTime() + 1000));
  assert.equal((await entitlementService.resolveEffective(ws.tenantId)).state, 'expired');
  assert.equal((await billingLifecycle.runLifecycleSweep()).expired, 1);
  assert.equal((await sub(ws)).state, 'expired');

  clock.reset();
  const other = await workspace();
  await onPaidTerm(other, 'pro');
  const now = await api(`${PREFIX}/tenants/${other.tenantId}/subscription/cancel`, {
    method: 'POST', headers: other.auth, body: { immediate: true },
  });
  assert.equal(now.status, 200);
  const ent = await entitlementService.resolveEffective(other.tenantId);
  assert.equal(ent.writeBlocked, true);
  // Reactivation cannot resurrect an ended term.
  const reactivate = await api(`${PREFIX}/tenants/${other.tenantId}/subscription/reactivate`, {
    method: 'POST', headers: other.auth,
  });
  assert.equal(reactivate.status, 409);
});

/* --------------------------- reconciliation ----------------------------- */

test('reconcile is not head-of-line blocked by stale pending checkouts', async () => {
  const ws = await workspace();
  const old = new Date(Date.now() - 5 * DAY);
  const stale = [];
  for (let i = 0; i < 30; i += 1) {
    const order = await provider.createOrder({ amountMinor: 99900, currency: 'INR', receipt: `r${i}` });
    stale.push({
      tenantId: ws.tenantId, planId: 'pro', amountMinor: 99900, currency: 'INR', provider: 'razorpay',
      providerOrderId: order.id, receipt: `r${i}`, status: 'pending', reconcileAttempts: 12,
      nextReconcileAt: old, interval: 'month', termMonths: 1,
    });
  }
  await PaymentTransaction.insertMany(stale);
  await PaymentTransaction.updateMany({}, { $set: { createdAt: old } }, { timestamps: false, strict: false });
  const paid = await checkout(ws, 'pro', 'year');
  provider.pay(paid.orderId, { amount: paid.amountMinor });

  const later = new Date(Date.now() + 10 * 60 * 1000);
  const first = await billingReconcile.reconcilePending({ limit: 25, now: later });
  assert.equal(first.expired, 25, 'stale rows are expired, not retried forever');
  const second = await billingReconcile.reconcilePending({ limit: 25, now: later });
  assert.equal(second.captured, 1, 'the paid checkout behind them is reached');
  assert.equal(await PaymentTransaction.countDocuments({ status: 'expired' }), 30);
  assert.equal((await sub(ws)).planId, 'pro');
});

test('reconcile backs off unpaid checkouts instead of re-checking them every run', async () => {
  const ws = await workspace();
  await checkout(ws);
  const t1 = new Date(Date.now() + 10 * 60 * 1000);
  const r1 = await billingReconcile.reconcilePending({ now: t1 });
  assert.equal(r1.skipped, 1);
  const r2 = await billingReconcile.reconcilePending({ now: new Date(t1.getTime() + 1000) });
  assert.equal(r2.checked, 0, 'the row is not due yet');
});

/* ------------------------- feature entitlements ------------------------- */

test('requireFeature denies features the plan lacks (403 FEATURE_NOT_AVAILABLE)', async () => {
  const ws = await workspace();
  const embed = await api(`${PREFIX}/embed/tokens`, { method: 'POST', headers: ws.auth, body: {} });
  assert.equal(embed.status, 403);
  assert.equal(embed.json.code, 'FEATURE_NOT_AVAILABLE');
  const key = await api(`${PREFIX}/api-keys`, { method: 'POST', headers: ws.auth, body: { name: 'k' } });
  assert.equal(key.status, 403);
  assert.equal(key.json.code, 'FEATURE_NOT_AVAILABLE');
  const scheduled = await api(`${PREFIX}/reports`, {
    method: 'POST',
    headers: ws.auth,
    body: { name: 'Weekly', schedule: { enabled: true, cron: '0 9 * * 1', recipients: ['a@example.com'] } },
  });
  assert.equal(scheduled.status, 403);
  assert.equal(scheduled.json.code, 'FEATURE_NOT_AVAILABLE');

  // With a plan that includes the features, the gate lets the request through.
  await entitleTenant(ws.tenantId, 'enterprise');
  const allowed = await api(`${PREFIX}/embed/tokens`, { method: 'POST', headers: ws.auth, body: {} });
  assert.notEqual(allowed.status, 403);
  const keyOk = await api(`${PREFIX}/api-keys`, { method: 'POST', headers: ws.auth, body: { name: 'k', scopes: ['datasets:read'] } });
  assert.notEqual(keyOk.status, 403);
});

test('external API calls need api_access on the plan', async () => {
  const ws = await workspace();
  await entitleTenant(ws.tenantId, 'pro');
  const created = await api(`${PREFIX}/api-keys`, { method: 'POST', headers: ws.auth, body: { name: 'ext', scopes: ['datasets:read'] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const { secret } = created.json.data;
  assert.equal((await api(`${PREFIX}/external/datasets`, { headers: { 'X-Api-Key': secret } })).status, 200);
  await entitleTenant(ws.tenantId, 'free');
  const denied = await api(`${PREFIX}/external/datasets`, { headers: { 'X-Api-Key': secret } });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'FEATURE_NOT_AVAILABLE');
});

test('hasFeature: overrides, legacy aliases, restricted state and unknown keys', async () => {
  const ws = await workspace();
  assert.equal(await entitlementService.hasFeature({ tenantId: ws.tenantId, feature: 'sso' }), false);
  await entitleTenant(ws.tenantId, 'enterprise');
  assert.equal(await entitlementService.hasFeature({ tenantId: ws.tenantId, feature: 'sso' }), true);
  await Subscription.updateOne({ tenantId: ws.tenantId }, { $set: { state: 'restricted', adminHold: true } });
  assert.equal(await entitlementService.hasFeature({ tenantId: ws.tenantId, feature: 'sso' }), false);
  // A catalogue row seeded before the contract keys still answers through the alias.
  await MasterData.updateOne({ catalogue: 'plans', code: 'pro' }, { $unset: { 'data.features.embedding': '' }, $set: { 'data.features.embed': true } });
  await entitleTenant(ws.tenantId, 'pro');
  assert.equal(await entitlementService.hasFeature({ tenantId: ws.tenantId, feature: 'embedding' }), true);
  assert.equal(await entitlementService.hasFeature({ tenantId: null, feature: 'embedding' }), false);
  assert.throws(() => requireFeature('not_a_feature'), /unknown feature/);
});

/* --------------------------- catalogue seed ----------------------------- */

test('catalogue seeding is idempotent and keeps edited prices unless asked', async () => {
  const again = await planService.ensureDefaults('test', { mapping: MAPPING });
  assert.equal(again.created.length, 0);
  assert.deepEqual(again.updated, []);
  const pro = await planService.getByCode('pro');
  await planService.update(pro.id, { data: { ...pro.data, prices: [{ interval: 'month', amountMinor: 123400, currency: 'INR' }] } }, 'admin');
  await planService.ensureDefaults('test', { mapping: MAPPING });
  assert.equal((await planService.getByCode('pro')).data.prices[0].amountMinor, 123400, 'edited price kept');
  await planService.ensureDefaults('test', { mapping: MAPPING, overwritePrices: true });
  assert.equal((await planService.getByCode('pro')).data.prices.find((p) => p.interval === 'month').amountMinor, 99900);
  // A row missing newer feature keys gains them without flipping edited ones.
  await MasterData.updateOne({ catalogue: 'plans', code: 'starter' }, { $unset: { 'data.features.ai_assistant': '' }, $set: { 'data.features.api_access': false } });
  await planService.ensureDefaults('test', { mapping: MAPPING });
  const starter = await planService.getByCode('starter');
  assert.equal(starter.data.features.ai_assistant, false);
  assert.equal(starter.data.features.api_access, false, 'edited value kept');
  await assert.rejects(
    planService.update(pro.id, { data: { ...pro.data, prices: [{ interval: 'week', amountMinor: 1, currency: 'INR' }] } }, 'admin'),
    (err) => err.statusCode === 422,
  );
});

/* --------------------- plans, history and isolation --------------------- */

test('plans endpoint is driven by the catalogue and reports the provider mode', async () => {
  const ws = await workspace();
  const res = await api(`${PREFIX}/tenants/${ws.tenantId}/plans`, { headers: ws.auth });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.checkout.enabled, true);
  assert.equal(res.json.data.checkout.environment, 'test');
  const pro = res.json.data.plans.find((p) => p.code === 'pro');
  assert.deepEqual(pro.prices.map((p) => p.interval).sort(), ['month', 'year']);
  assert.equal(pro.purchasable, true);
  assert.equal(res.json.data.plans.find((p) => p.code === 'free').purchasable, false);
  __clearTestProviders();
  const off = await api(`${PREFIX}/tenants/${ws.tenantId}/plans`, { headers: ws.auth });
  assert.equal(off.json.data.checkout.enabled, false);
  assert.equal(off.json.data.checkout.environment, null);
});

test('billing history and checkout status are tenant-isolated and need permission', async () => {
  const a = await workspace();
  const b = await workspace();
  const session = await checkout(a);
  const history = await api(`${PREFIX}/tenants/${a.tenantId}/subscription/transactions`, { headers: a.auth });
  assert.equal(history.status, 200);
  assert.equal(history.json.data.length, 1);
  assert.equal(history.json.data[0].orderId, session.orderId);
  assert.ok(!JSON.stringify(history.json.data).includes(KEY_SECRET));
  const cross = await api(`${PREFIX}/tenants/${a.tenantId}/subscription/transactions`, { headers: b.auth });
  assert.equal(cross.status, 403);
  const foreignOrder = await api(`${PREFIX}/tenants/${b.tenantId}/subscription/checkout/${session.orderId}`, { headers: b.auth });
  assert.equal(foreignOrder.status, 404);
  assert.equal((await api(`${PREFIX}/tenants/${b.tenantId}/subscription/transactions`, { headers: b.auth })).json.data.length, 0);
  const viewer = await member(a, 'Viewer');
  const denied = await api(`${PREFIX}/tenants/${a.tenantId}/subscription/checkout`, {
    method: 'POST', headers: viewer.auth, body: { planId: 'pro' },
  });
  assert.equal(denied.status, 403);
  const badOrder = await api(`${PREFIX}/tenants/${a.tenantId}/subscription/checkout/bad$order`, { headers: a.auth });
  assert.equal(badOrder.status, 422);
});

/* ----------------------------- migration -------------------------------- */

test('prepaid-term migration: dry run by default; never-paid rows to free, paid rows get a notice term', async () => {
  const { run } = await import('../../scripts/ci/migrate-billing-terms.js');
  const unpaid = await Tenant.create({ name: 'Legacy unpaid', slug: `lu-${randomBytes(3).toString('hex')}`, status: 'active' });
  const paid = await Tenant.create({ name: 'Legacy paid', slug: `lp-${randomBytes(3).toString('hex')}`, status: 'active' });
  const long = new Date(Date.now() - 90 * DAY);
  await Subscription.create({
    tenantId: String(unpaid._id), planId: 'starter', state: 'active', currentPeriodStart: long, currentPeriodEnd: new Date(long.getTime() + 30 * DAY),
  });
  await Subscription.create({
    tenantId: String(paid._id), planId: 'pro', state: 'active', currentPeriodStart: long, currentPeriodEnd: new Date(long.getTime() + 30 * DAY),
    paymentProvider: 'razorpay', paymentReference: 'order_legacy',
  });
  const lines = [];
  const dry = await run({ log: (l) => lines.push(l) });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.movedToFree, 1);
  assert.equal(dry.noticeExtended, 1);
  assert.equal((await Subscription.findOne({ tenantId: String(unpaid._id) }).lean()).planId, 'starter', 'dry run writes nothing');
  assert.ok(lines.some((l) => /Dry run only/.test(l)));

  const applied = await run({ apply: true, noticeDays: 30, log: () => {} });
  assert.equal(applied.movedToFree, 1);
  assert.equal(applied.noticeExtended, 1);
  assert.equal((await Subscription.findOne({ tenantId: String(unpaid._id) }).lean()).planId, 'free');
  const migrated = await Subscription.findOne({ tenantId: String(paid._id) }).lean();
  assert.equal(migrated.planId, 'pro');
  assert.ok(new Date(migrated.currentPeriodEnd).getTime() > Date.now() + 29 * DAY);
  assert.equal((await entitlementService.resolveEffective(String(paid._id))).state, 'active');
  assert.equal(await SubscriptionHistory.countDocuments({ type: 'subscription.migrated' }), 2);
  const again = await run({ apply: true, log: () => {} });
  assert.equal(again.movedToFree + again.noticeExtended, 0, 're-running is a no-op');
});

test('admin override: plan and term are changed only through the audited admin route', async () => {
  const ws = await workspace();
  const end = new Date(Date.now() + 60 * DAY).toISOString();
  const changed = await subscriptionService.changePlan({
    tenantId: ws.tenantId,
    planId: 'enterprise',
    actor: { type: 'admin', id: 'admin-1' },
    by: 'admin-1',
    reason: 'Signed offline contract',
    termEnd: end,
    historyType: 'subscription.override_applied',
  });
  assert.equal(changed.planId, 'enterprise');
  assert.equal(new Date(changed.currentPeriodEnd).toISOString(), end);
  const row = await SubscriptionHistory.findOne({ tenantId: ws.tenantId, type: 'subscription.override_applied' }).lean();
  assert.equal(row.reason, 'Signed offline contract');
  assert.equal(row.actor.id, 'admin-1');
});
