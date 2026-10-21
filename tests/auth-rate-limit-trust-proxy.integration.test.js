/**
 * Auth rate limits with a directly exposed port (sec.11).
 *
 * With `TRUST_PROXY=0` (no reverse proxy in front of the API) the limiters
 * key on the socket address. A client that sends a fresh `X-Forwarded-For`
 * on every request must not get a fresh bucket each time. Runs in its own
 * process with small limits set BEFORE the app is imported.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRUST_PROXY = '0';
process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '2';
process.env.AUTH_RATE_LIMIT_LOGIN_IP_MAX = '3';
process.env.AUTH_RATE_LIMIT_REFRESH_MAX = '2';

const { startMongo, stopMongo, resetMongo } = await import('./helpers/mongo.js');
const { startHttp, stopHttp, api } = await import('./helpers/http.js');

before(async () => { await startMongo(); await startHttp(); });
beforeEach(async () => { await resetMongo(); });
after(async () => { await stopHttp(); await stopMongo(); });

let spoofed = 0;
const spoof = () => {
  spoofed += 1;
  return { 'X-Forwarded-For': `198.51.100.${spoofed}` };
};

test('a spoofed X-Forwarded-For does not reset the login limit when no proxy is trusted', async () => {
  const login = () => api('/api/v1/auth/login', {
    method: 'POST',
    headers: { ...spoof(), 'X-Tenant-Id': 'acme' },
    body: { email: 'victim@example.com', password: 'WrongPassword1!' },
  });
  for (let i = 0; i < 2; i += 1) assert.notEqual((await login()).status, 429);
  const limited = await login();
  assert.equal(limited.status, 429, 'every spoofed address shares the real client bucket');
  assert.equal(limited.json.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('a spoofed X-Forwarded-For does not reset the refresh limit when no proxy is trusted', async () => {
  const refresh = () => api('/api/v1/auth/refresh', { method: 'POST', headers: spoof() });
  for (let i = 0; i < 2; i += 1) assert.equal((await refresh()).status, 401);
  assert.equal((await refresh()).status, 429);
});
