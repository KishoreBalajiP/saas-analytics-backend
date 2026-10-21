/**
 * Tenant MFA rate limiting (roadmap 4.E1, mfa-tenant).
 *
 * The test runner disables the auth limiters (10000/window). This file runs
 * in its own process and sets a SMALL MFA limit BEFORE the app is imported,
 * so the real `userAuthLimiters.mfa` bucket is exercised on the real routes:
 * it is keyed per signed-in user (another user on the same IP is
 * unaffected) and shared by verify, disable and step-up.
 */

import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_RATE_LIMIT_MFA_MAX = '3';

const { startMongo, stopMongo, resetMongo } = await import('../helpers/mongo.js');
const { startHttp, stopHttp, api } = await import('../helpers/http.js');
const { default: rbacCache } = await import('../../src/services/rbac.cache.service.js');
const cacheService = await import('../../src/services/cache.service.js');
const { PASSWORD, signIn, onboard, addMember, resetTotpClock, restoreClock } = await import('./helpers.js');

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  await cacheService.flushAll();
  resetTotpClock();
});
afterEach(() => restoreClock());
after(async () => { await stopHttp(); await stopMongo(); });

test('MFA attempts are rate-limited per user with a typed 429', async () => {
  const { tenantId } = await onboard();
  const a = await signIn(tenantId, (await addMember(tenantId, 'Viewer')).email);
  const b = await signIn(tenantId, (await addMember(tenantId, 'Viewer')).email);

  const enroll = await api('/api/v1/auth/mfa/enroll', { method: 'POST', headers: a.auth });
  assert.equal(enroll.status, 200);
  // Two wrong guesses fill the bucket (enroll + 2 = 3); the next is refused.
  for (let i = 0; i < 2; i += 1) {
    const res = await api('/api/v1/auth/mfa/verify', { method: 'POST', headers: a.auth, body: { code: '000000' } });
    assert.equal(res.status, 400);
  }
  const limited = await api('/api/v1/auth/mfa/verify', { method: 'POST', headers: a.auth, body: { code: '000000' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, 'RATE_LIMITED');
  assert.ok(limited.headers.get('retry-after'));
  // Step-up shares the bucket.
  const stepUp = await api('/api/v1/auth/step-up', { method: 'POST', headers: a.auth, body: { password: PASSWORD } });
  assert.equal(stepUp.status, 429);

  // Another user on the same IP has their own bucket.
  const other = await api('/api/v1/auth/mfa/enroll', { method: 'POST', headers: b.auth });
  assert.equal(other.status, 200);
});
