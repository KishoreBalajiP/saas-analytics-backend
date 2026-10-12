/**
 * Payment provider adapter (Phase 6 - implemented, noop only).
 *
 * PURPOSE
 *   The provider-neutral adapter boundary. Phase 6 ships a `noop`
 *   provider that honestly returns 501 for every operation. A future
 *   Stripe / Paddle / Chargebee integration plugs in by registering
 *   itself under its provider name and replacing the `getProvider()`
 *   resolution.
 *
 * CONTRACT
 *   - `name`: string identifier (e.g. `noop`, `stripe`).
 *   - `createCheckoutSession({ tenantId, planId, successUrl, cancelUrl })`:
 *     Returns `{ providerRef, redirectUrl }` on success; the redirect
 *     URL is where the user must complete payment. The caller MUST
 *     surface 501 (NOT a fake success) when the provider is not yet
 *     wired up.
 *   - `handleWebhook(req)`: receives the raw, signature-verified HTTP
 *     request. The route layer is responsible for verifying the
 *     provider's signature using the provider's official mechanism
 *     BEFORE the request reaches this method. Returns
 *     `{ handled: boolean, event?: NormalizedEvent }`.
 *   - `cancel({ providerRef, at })`: cancel a subscription at the
 *     provider. Returns `{ canceled: boolean }`.
 *   - `reconcile({ tenantId })`: pull the canonical state from the
 *     provider. Returns an array of normalized events.
 *
 * WHY NOOP ONLY
 *   - No provider has been selected. The Phase 6 deliverable is the
 *     boundary; the provider itself is recorded as a deferred
 *     decision in the plan and the report.
 */

import ApiError from '../utils/ApiError.js';

const NOT_IMPLEMENTED = 'Checkout is not yet available. Contact support to change plans.';

const noopProvider = Object.freeze({
  name: 'noop',
  isImplemented: false,
  async createCheckoutSession() {
    throw ApiError.notImplemented(NOT_IMPLEMENTED);
  },
  async handleWebhook() {
    return { handled: false, reason: 'noop_provider' };
  },
  async cancel() {
    return { canceled: false, reason: 'noop_provider' };
  },
  async reconcile() {
    return [];
  },
});

/** Registry of available providers. Only `noop` is registered in Phase 6. */
const PROVIDERS = Object.freeze({
  noop: noopProvider,
});

/** Resolve a provider by name. Falls back to `noop` (and never throws)
 *  so the rest of the codebase can call `getProvider()` without
 *  checking the env first. */
export function getProvider(name = null) {
  if (name && PROVIDERS[name]) return PROVIDERS[name];
  return PROVIDERS.noop;
}

export function listProviders() {
  return Object.entries(PROVIDERS).map(([key, p]) => ({
    name: p.name,
    isImplemented: p.isImplemented === true,
  }));
}

export const PAYMENT_PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));

export default {
  getProvider,
  listProviders,
  PAYMENT_PROVIDER_NAMES,
  _meta: { implemented: false, current: 'noop' },
};
