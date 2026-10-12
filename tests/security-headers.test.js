/**
 * Security header tests.
 *
 * Verifies that Helmet is correctly configured and that the required
 * security headers are present on all API responses. Also verifies that
 * the CSP and HSTS directives are appropriate for the deployment environment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';

test('Helmet sets X-Content-Type-Options: nosniff', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
});

test('Helmet sets X-Frame-Options', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.ok(res.headers.get('x-frame-options'));
});

test('Helmet sets X-XSS-Protection', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.ok(res.headers.get('x-xss-protection'));
});

test('Helmet sets Referrer-Policy', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.ok(res.headers.get('referrer-policy'));
});

test('Helmet sets CSP header', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'Content-Security-Policy header should be set');
});

test('CSP default-src is self', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp && csp.includes("default-src 'self'"));
});

test('CSP script-src is self', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp && csp.includes("script-src 'self'"));
});

test('CSP style-src allows unsafe-inline', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp && csp.includes("style-src 'self'") && csp.includes("'unsafe-inline'"));
});

test('CSP img-src allows data:', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp && csp.includes("img-src 'self'") && csp.includes('data:'));
});

test('CSP frame-src is none', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp && csp.includes("frame-src 'none'"));
});

test('CSP object-src is none', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp && csp.includes("object-src 'none'"));
});

test('X-Powered-By is disabled', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test('HSTS omitted in development (NODE_ENV=development)', async (t) => {
  // This test runs under the test runner which sets NODE_ENV=development.
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.strictEqual(res.headers.get('strict-transport-security'), null);
});

test('application routes still work with Helmet', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.strictEqual(res.status, 200);
});