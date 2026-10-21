/**
 * Step-up window (adminauth, roadmap 2.2): freshness is evaluated from the
 * session's server-side stamp against ADMIN_STEP_UP_TTL_MS, and the guard
 * fails closed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isStepUpFresh, STEP_UP_TTL_MS } from '../../src/modules/iam/auth/stepUp.service.js';
import { requireAdminStepUp, stepUpWhen } from '../../src/middleware/stepUp.middleware.js';

function run(mw, req) {
  return new Promise((resolve) => {
    mw(req, {}, (err) => resolve(err ?? null));
  });
}

test('isStepUpFresh: inside the window only', () => {
  const now = Date.now();
  assert.equal(isStepUpFresh(null, now), false);
  assert.equal(isStepUpFresh(undefined, now), false);
  assert.equal(isStepUpFresh(now - 1000, now), true);
  assert.equal(isStepUpFresh(new Date(now - STEP_UP_TTL_MS + 1000), now), true);
  assert.equal(isStepUpFresh(new Date(now - STEP_UP_TTL_MS - 1).toISOString(), now), false);
  assert.equal(isStepUpFresh(now + 60_000, now), false, 'a stamp in the future is not trusted');
  assert.equal(isStepUpFresh('garbage', now), false);
});

test('requireAdminStepUp: 403 STEP_UP_REQUIRED without a fresh stamp, passes with one', async () => {
  const guard = requireAdminStepUp();
  const stale = await run(guard, { admin: { id: 'a1', stepUpAt: Date.now() - STEP_UP_TTL_MS - 5000 } });
  assert.equal(stale.statusCode, 403);
  assert.equal(stale.code, 'STEP_UP_REQUIRED');
  assert.equal((await run(guard, { admin: { id: 'a1', stepUpAt: null } })).code, 'STEP_UP_REQUIRED');
  assert.equal(await run(guard, { admin: { id: 'a1', stepUpAt: Date.now() } }), null);
  assert.equal((await run(guard, {})).statusCode, 401, 'no admin identity');
});

test('requireAdminStepUp({ when }): only sensitive requests are guarded; a throwing predicate fails closed', async () => {
  const guard = requireAdminStepUp({ when: stepUpWhen.grantsSuperType });
  assert.equal(await run(guard, { admin: { id: 'a1' }, validated: { body: { adminType: 'support' } } }), null);
  const denied = await run(guard, { admin: { id: 'a1' }, validated: { body: { adminType: 'super' } } });
  assert.equal(denied.code, 'STEP_UP_REQUIRED');
  const boom = requireAdminStepUp({ when: () => { throw new Error('lookup failed'); } });
  const err = await run(boom, { admin: { id: 'a1', stepUpAt: Date.now() } });
  assert.equal(err.message, 'lookup failed');
});

test('stepUpWhen.readsSecrets recognises the includeSecrets switch', () => {
  assert.equal(stepUpWhen.readsSecrets({ query: { includeSecrets: 'true' } }), true);
  assert.equal(stepUpWhen.readsSecrets({ query: { includeSecrets: '1' } }), true);
  assert.equal(stepUpWhen.readsSecrets({ query: { includeSecrets: 'false' } }), false);
  assert.equal(stepUpWhen.readsSecrets({ query: {} }), false);
});
