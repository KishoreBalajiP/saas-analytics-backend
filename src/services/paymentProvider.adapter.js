/**
 * Payment provider adapter (Phase 6.1 - Razorpay one-time order flow).
 *
 * PURPOSE
 *   The provider-neutral adapter boundary. When `RAZORPAY_ENABLED=true`
 *   (with valid credentials) the `razorpay` provider talks to the
 *   Razorpay Orders/Payments APIs in TEST mode by default; otherwise the
 *   `noop` provider honestly returns 501 for every operation.
 *
 * FLOW (one-time orders - NOT recurring subscriptions)
 *   1. Backend creates a Razorpay Order (server-controlled amount in
 *      minor units) and persists a pending PaymentTransaction.
 *   2. Frontend opens Razorpay Checkout with the public Key ID + order_id.
 *   3. Backend verifies the checkout signature (HMAC order|payment) and
 *      the payment entity (status/amount/currency/association) BEFORE
 *      touching the subscription.
 *   4. Webhooks (`payment.captured`, `payment.failed`, `refund.*`,
 *      `order.paid`) are signature-verified against the RAW body and
 *      processed idempotently through the same lifecycle service.
 *
 * CONTRACT
 *   - `name`: 'noop' | 'razorpay'.
 *   - `isImplemented`: false for noop.
 *   - `createOrder({ amountMinor, currency, receipt, notes })`
 *   - `fetchOrder(orderId)`, `fetchPayment(paymentId)`
 *   - `verifyCheckoutSignature({ orderId, paymentId, signature })`
 *   - `verifyWebhookSignature(rawBody, signature)`
 *   - `cancel()` - one-time orders have nothing to cancel at the
 *     provider; returns an honest not-supported result.
 *
 * SECURITY
 *   - Amounts/currency always come from `billingPricing.service.js`.
 *   - Never logs credentials, signatures, or full provider payloads.
 *   - All comparisons are constant-time.
 *   - Request timeouts bound every provider call.
 */

import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import config from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

export const NOT_IMPLEMENTED_MESSAGE =
  'Checkout is not yet available. Contact support to change plans.';

export const WEBHOOK_EVENT_ALLOWLIST = Object.freeze([
  'payment.captured',
  'payment.failed',
  'order.paid',
  'refund.created',
  'refund.processed',
]);

export const REQUEST_TIMEOUT_MS = 15000;

/** Injectable SDK factory so tests mock ONLY the provider boundary. */
let sdkFactory = ({ keyId, keySecret }) => new Razorpay({ key_id: keyId, key_secret: keySecret });

export function setSdkFactory(fn) {
  sdkFactory = fn;
}

export function resetSdkFactory() {
  sdkFactory = ({ keyId, keySecret }) => new Razorpay({ key_id: keyId, key_secret: keySecret });
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** HMAC-SHA256 hex of `data` (Buffer|string) with `secret`. */
export function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/** Official Razorpay checkout verification: HMAC(order_id|payment_id). */
export function verifyCheckoutSignature({ orderId, paymentId, signature, keySecret }) {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  const expected = hmacHex(keySecret, `${orderId}|${paymentId}`);
  return timingSafeEqualHex(expected, signature);
}

/** Official Razorpay webhook verification: HMAC(rawBody) with webhook secret. */
export function verifyWebhookSignature({ rawBody, signature, webhookSecret }) {
  if (!rawBody || !signature || !webhookSecret) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = hmacHex(webhookSecret, body);
  return timingSafeEqualHex(expected, signature);
}

function toProviderError(err) {
  const description = err?.error?.description || err?.description || err?.message || 'Provider request failed';
  const statusCode = err?.statusCode;
  // Never include credentials or full payloads; the description is safe.
  return ApiError.serviceUnavailable(`Payment provider error: ${String(description).slice(0, 200)}`, {
    code: 'PROVIDER_ERROR',
  });
}

/**
 * Normalize a verified webhook body. Unknown events are returned with
 * `supported: false` so the caller acks them without mutation.
 */
export function normalizeWebhookEvent(payload) {
  const event = payload?.event ?? 'unknown';
  const supported = WEBHOOK_EVENT_ALLOWLIST.includes(event);
  const entity =
    payload?.payload?.payment?.entity ??
    payload?.payload?.refund?.entity ??
    payload?.payload?.order?.entity ??
    null;
  return {
    event,
    supported,
    entityId: entity?.id ?? null,
    orderId: entity?.order_id ?? payload?.payload?.order?.entity?.id ?? null,
    paymentId:
      entity?.id && event.startsWith('payment.') ? entity.id : (payload?.payload?.payment?.entity?.id ?? null),
    amount: entity?.amount ?? null,
    currency: entity?.currency ?? null,
    status: entity?.status ?? null,
    createdAt: payload?.created_at ? new Date(payload.created_at * 1000) : new Date(),
    notes: entity?.notes ?? {},
  };
}

function withTimeout(promise, ms = REQUEST_TIMEOUT_MS, label = 'provider') {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(ApiError.serviceUnavailable(`Payment provider timed out (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildRazorpayProvider() {
  const { keyId, keySecret, webhookSecret, environment } = config.razorpay;
  let sdk = null;
  try {
    sdk = sdkFactory({ keyId, keySecret });
  } catch {
    sdk = null;
  }

  const provider = Object.freeze({
    name: 'razorpay',
    isImplemented: Boolean(sdk),
    environment,
    keyId,

    async createOrder({ amountMinor, currency, receipt, notes = {} } = {}) {
      if (!sdk) throw ApiError.notImplemented(NOT_IMPLEMENTED_MESSAGE);
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw ApiError.badRequest('amountMinor must be a positive integer in minor units');
      }
      if (!currency || !receipt) throw ApiError.badRequest('currency and receipt are required');
      // Strip anything sensitive from notes; keep only safe identifiers.
      const safeNotes = {
        ...(notes.tenantId ? { tenantId: String(notes.tenantId) } : {}),
        ...(notes.planId ? { planId: String(notes.planId) } : {}),
        ...(notes.transactionId ? { transactionId: String(notes.transactionId) } : {}),
      };
      try {
        const order = await withTimeout(
          sdk.orders.create({ amount: amountMinor, currency, receipt, notes: safeNotes }),
          REQUEST_TIMEOUT_MS,
          'orders.create',
        );
        return {
          id: order.id,
          amount: order.amount,
          currency: order.currency,
          receipt: order.receipt,
          status: order.status,
        };
      } catch (err) {
        if (err instanceof ApiError) throw err;
        logger.warn({ err: { message: err?.message }, op: 'razorpay.orders.create' }, 'Provider order creation failed');
        throw toProviderError(err);
      }
    },

    async fetchOrder(orderId) {
      if (!sdk) throw ApiError.notImplemented(NOT_IMPLEMENTED_MESSAGE);
      if (!orderId) throw ApiError.badRequest('orderId is required');
      try {
        const order = await withTimeout(sdk.orders.fetch(orderId), REQUEST_TIMEOUT_MS, 'orders.fetch');
        return {
          id: order.id,
          amount: order.amount,
          currency: order.currency,
          receipt: order.receipt,
          status: order.status,
          amount_paid: order.amount_paid ?? null,
          amount_due: order.amount_due ?? null,
        };
      } catch (err) {
        if (err instanceof ApiError) throw err;
        logger.warn({ op: 'razorpay.orders.fetch' }, 'Provider order fetch failed');
        throw toProviderError(err);
      }
    },

    async fetchPayment(paymentId) {
      if (!sdk) throw ApiError.notImplemented(NOT_IMPLEMENTED_MESSAGE);
      if (!paymentId) throw ApiError.badRequest('paymentId is required');
      try {
        const payment = await withTimeout(sdk.payments.fetch(paymentId), REQUEST_TIMEOUT_MS, 'payments.fetch');
        return {
          id: payment.id,
          order_id: payment.order_id ?? null,
          status: payment.status,
          amount: payment.amount,
          currency: payment.currency,
          method: payment.method ?? null,
          captured: payment.captured === true,
        };
      } catch (err) {
        if (err instanceof ApiError) throw err;
        logger.warn({ op: 'razorpay.payments.fetch' }, 'Provider payment fetch failed');
        throw toProviderError(err);
      }
    },

    verifyCheckoutSignature({ orderId, paymentId, signature }) {
      return verifyCheckoutSignature({ orderId, paymentId, signature, keySecret });
    },

    verifyWebhookSignature(rawBody, signature) {
      return verifyWebhookSignature({ rawBody, signature, webhookSecret });
    },

    normalizeWebhookEvent,

    async cancel() {
      // One-time Razorpay orders are not cancelable provider-side; the
      // workspace cancel endpoint owns subscription cancellation.
      return { canceled: false, reason: 'one_time_orders_not_cancelable_at_provider' };
    },

    async handleWebhook() {
      return { handled: false, reason: 'use_verifyWebhookSignature_and_normalizeWebhookEvent' };
    },

    async createCheckoutSession() {
      // Kept for interface compatibility; the one-time flow uses createOrder.
      throw ApiError.notImplemented(
        'Use the workspace checkout endpoint, which creates a provider order with server-controlled pricing.',
      );
    },

    async reconcile() {
      return [];
    },
  });

  return provider;
}

const noopProvider = Object.freeze({
  name: 'noop',
  isImplemented: false,
  async createOrder() {
    throw ApiError.notImplemented(NOT_IMPLEMENTED_MESSAGE);
  },
  async fetchOrder() {
    throw ApiError.notImplemented(NOT_IMPLEMENTED_MESSAGE);
  },
  async fetchPayment() {
    throw ApiError.notImplemented(NOT_IMPLEMENTED_MESSAGE);
  },
  verifyCheckoutSignature() {
    return false;
  },
  verifyWebhookSignature() {
    return false;
  },
  normalizeWebhookEvent(payload) {
    return { event: payload?.event ?? 'unknown', supported: false };
  },
  async cancel() {
    return { canceled: false, reason: 'noop_provider' };
  },
  async handleWebhook() {
    return { handled: false, reason: 'noop_provider' };
  },
  async createCheckoutSession() {
    throw ApiError.notImplemented(NOT_IMPLEMENTED_MESSAGE);
  },
  async reconcile() {
    return [];
  },
});

let cached = null;

/** Test-only provider overrides (mock the external boundary, never prod). */
const testOverrides = new Map();

export function __setTestProvider(name, provider) {
  testOverrides.set(name, provider);
  if (name === 'razorpay' || name === null) cached = null;
}

export function __clearTestProviders() {
  testOverrides.clear();
  cached = null;
}

function disabledRazorpayStub() {
  return Object.freeze({
    ...noopProvider,
    name: 'razorpay',
    isImplemented: false,
    async createOrder() {
      throw ApiError.notImplemented(NOT_IMPLEMENTED_MESSAGE);
    },
  });
}

/** Resolve the active provider. Rebuilt when config flips in tests. */
export function getProvider(name = null) {
  if (name !== null && testOverrides.has(name)) return testOverrides.get(name);
  if (name === null && testOverrides.has('__default')) return testOverrides.get('__default');
  if (name === 'noop') return noopProvider;
  if (name === 'razorpay') {
    if (config?.razorpay?.enabled !== true) return disabledRazorpayStub();
    if (!cached) cached = buildRazorpayProvider();
    return cached;
  }
  if (config?.razorpay?.enabled === true) {
    if (!cached) cached = buildRazorpayProvider();
    return cached;
  }
  return noopProvider;
}

/** Test hook: drop the cached provider so a fresh one is built. */
export function resetProviderCache() {
  cached = null;
}

export function listProviders() {
  const rzp = getProvider('razorpay');
  return [
    { name: 'noop', isImplemented: false },
    { name: 'razorpay', isImplemented: config?.razorpay?.enabled === true && rzp.isImplemented },
  ];
}

export const PAYMENT_PROVIDER_NAMES = Object.freeze(['noop', 'razorpay']);

export default {
  getProvider,
  listProviders,
  resetProviderCache,
  setSdkFactory,
  resetSdkFactory,
  __setTestProvider,
  __clearTestProviders,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  hmacHex,
  WEBHOOK_EVENT_ALLOWLIST,
  PAYMENT_PROVIDER_NAMES,
  _meta: { module: 'billing.provider' },
};
