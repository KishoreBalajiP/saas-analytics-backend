/**
 * HTTP test helper - boot the real Express app on an ephemeral port and make
 * JSON requests against it with cookie capture/replay.
 *
 * WHY IT EXISTS
 *   Integration tests need real HTTP round-trips through `app.js` (middleware
 *   order, rate limiters, cookie parsing, error envelopes). Using the built-in
 *   `fetch` keeps the suite dependency-free - no supertest/axios needed.
 *
 * USAGE
 *   ```js
 *   import { startHttp, stopHttp, api, refreshCookieFrom } from './http.js';
 *
 *   before(async () => { await startMongo(); await startHttp(); });
 *   after(async () => { await stopHttp(); await stopMongo(); });
 *
 *   const res = await api('/api/v1/auth/login', { method: 'POST', body });
 *   const cookie = refreshCookieFrom(res); // -> 'saas_session=...'
 *   const me = await api('/api/v1/auth/me', { headers: { authorization: `Bearer ${token}` } });
 *   ```
 */

import app from '../../src/app.js';

let server = null;
let baseUrl = '';

/**
 * Bind the app to an ephemeral port (idempotent).
 * @returns {Promise<string>} base URL.
 */
export async function startHttp() {
  if (server) return baseUrl;
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

/**
 * Close the HTTP server (idempotent).
 * @returns {Promise<void>}
 */
export async function stopHttp() {
  if (!server) return;
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  server = null;
  baseUrl = '';
}

/**
 * Perform a JSON request against the running app.
 *
 * @param {string} path - absolute path (e.g. `/api/v1/auth/login`).
 * @param {Object} [opts]
 * @param {string} [opts.method='GET']
 * @param {Object} [opts.body] - JSON body (serialised automatically).
 * @param {Object} [opts.headers] - extra headers (e.g. `X-Tenant-Id`).
 * @param {string[]} [opts.cookies] - `name=value` cookie strings.
 * @returns {Promise<{ status: number, headers: Headers, json: Object|null, setCookie: string[] }>}
 */
export async function api(path, { method = 'GET', body, headers = {}, cookies = [] } = {}) {
  const cookieHeader = cookies.length > 0 ? { cookie: cookies.join('; ') } : {};
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...cookieHeader,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, setCookie };
}

/**
 * Extract the auth cookie (`saas_session=...`) from a response, ready to be
 * sent back via `opts.cookies`. Returns `null` when the cookie is absent.
 *
 * @param {{ setCookie: string[] }} resp
 * @returns {string|null}
 */
export function refreshCookieFrom(resp) {
  const line = resp.setCookie.find((c) => c.startsWith('saas_session='));
  return line ? line.split(';')[0] : null;
}

export default { startHttp, stopHttp, api, refreshCookieFrom };
