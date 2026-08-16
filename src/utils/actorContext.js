/**
 * actorContext.js - async request/worker actor context.
 *
 * WHY IT EXISTS
 *   The `audit` Mongoose plugin emits model-change events from inside
 *   `post` save hooks, which run outside the express `req`/`res` scope.
 *   Services called by controllers `await` the same work the plugin hooks
 *   observe, so the *actor* (and request id) that caused the mutation must
 *   travel with the async work. This module carries that context using
 *   `node:async_hooks#AsyncLocalStorage` so the plugin consumer can
 *   attribute a trail row to the real requester - without threading the
 *   identity through every service signature.
 *
 * RESPONSIBILITY
 *   - `runWithActor(actor, fn)` / `runWithContext({ actor, requestId }, fn)`
 *     - run `fn` with the identity visible to all async descendants.
 *   - `getCurrentActor()` / `getCurrentRequestId()` - read the context from
 *     a plugin hook, service, or worker.
 *   - Returns `null` / `undefined` outside a context (no fabricated actor).
 *
 * SECURITY RULES
 *   - Never fabricate an actor: outside a context the consumer falls back to
 *     the `system` actor, never to a guessed identity.
 *   - The auth middlewares are the ONLY producers on the HTTP path; a
 *     context never bypasses authentication.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with an actor visible to every async operation it spawns.
 *
 * @param {{ type: 'admin'|'user'|'service'|'system', id: string|null, tenantId?: string|null, email?: string|null } | null} actor
 * @param {Function} fn
 * @returns {*} the result of `fn`.
 */
export function runWithActor(actor, fn) {
  return storage.run({ actor: actor ?? null, requestId: null }, fn);
}

/**
 * Run `fn` with a full context (actor + requestId).
 *
 * @param {{ actor?: Object|null, requestId?: string|null }} ctx
 * @param {Function} fn
 * @returns {*} the result of `fn`.
 */
export function runWithContext({ actor = null, requestId = null } = {}, fn) {
  return storage.run({ actor: actor ?? null, requestId: requestId ?? null }, fn);
}

/** @returns {{ type: string, id: string|null, tenantId?: string|null, email?: string|null } | null} */
export function getCurrentActor() {
  const store = storage.getStore();
  return store?.actor ?? null;
}

/** @returns {string|null} the current request id, when the caller is inside a request. */
export function getCurrentRequestId() {
  const store = storage.getStore();
  return store?.requestId ?? null;
}

export default { runWithActor, runWithContext, getCurrentActor, getCurrentRequestId };
