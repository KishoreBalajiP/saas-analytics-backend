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
import queueService from '../../src/services/queue.service.js';
import logger from '../../src/utils/logger.js';

let server = null;
let baseUrl = '';

/**
 * Bind the app to an ephemeral port (idempotent).
 * @returns {Promise<string>} base URL.
 */
export async function startHttp() {
  if (server) return baseUrl;
  // Bind to the loopback address explicitly. On macOS a wildcard bind can be
  // shadowed by another process binding 127.0.0.1 on the same port (for
  // example a parallel test run), so requests would reach the wrong app.
  server = app.listen(0, '127.0.0.1');
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
  // app.js registers queue consumers at import time. Close those in-memory
  // handles during test teardown so their scheduled drains cannot keep Node's
  // event loop alive after the HTTP server and MongoDB are closed.
  await queueService.closeAll();
  await logger.flush?.();
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

/** Perform a multipart upload through the real HTTP app. */
export async function apiMultipart(path, { method = 'POST', headers = {}, fields = {}, file } = {}) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, String(value));
  if (file) formData.append('file', new Blob([file.buffer], { type: file.type }), file.name);
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: formData });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, headers: res.headers, json, setCookie };
}

/** Refresh-cookie names: tenant portal, admin portal. */
export const REFRESH_COOKIE_NAMES = Object.freeze(['saas_session', 'saas_admin_session']);

/**
 * Extract the refresh cookie (`saas_session=...` for the tenant portal,
 * `saas_admin_session=...` for the admin portal) from a response, ready to
 * be sent back via `opts.cookies`. Cleared cookies (empty value) are
 * skipped. Returns `null` when no refresh cookie was set.
 *
 * @param {{ setCookie: string[] }} resp
 * @param {string} [name] - restrict to one cookie name.
 * @returns {string|null}
 */
export function refreshCookieFrom(resp, name) {
  const names = name ? [name] : REFRESH_COOKIE_NAMES;
  const line = resp.setCookie.find((c) => {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    return eq > 0 && names.includes(pair.slice(0, eq)) && pair.slice(eq + 1).length > 0;
  });
  return line ? line.split(';')[0] : null;
}

export default { startHttp, stopHttp, api, apiMultipart, refreshCookieFrom, REFRESH_COOKIE_NAMES };
