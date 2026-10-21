/**
 * Delivery transports (delivery, roadmap 3.4).
 *
 * PURPOSE
 *   The outbound HTTP leg for webhook / Slack / Teams destinations, and the
 *   HMAC signing scheme for webhooks. Tests replace the HTTP transport with
 *   `setHttpTransport(fake)`; nothing here is called on the network in tests.
 *
 * SIGNING (same scheme as inbound webhook v2)
 *   X-Analivo-Timestamp: unix seconds
 *   X-Analivo-Signature: v2=<hex HMAC-SHA256(secret, `${timestamp}.${body}`)>
 *
 * SECURITY
 *   - Every URL passes the egress guard (`assertEgressAllowed`) before each
 *     attempt (private / loopback / metadata / platform hosts refused).
 *   - Redirects are not followed (a redirect could point inside the network).
 *   - Errors never carry the URL (it is a secret); only a status / code.
 */

import crypto from 'node:crypto';
import { assertEgressAllowed } from '../../utils/netGuard.js';
import env from '../../config/env.js';

export const TIMESTAMP_HEADER = 'x-analivo-timestamp';
export const SIGNATURE_HEADER = 'x-analivo-signature';

/** Typed transport failure: `transient` decides retry vs dead-letter. */
export class DeliveryTransportError extends Error {
  constructor(code, message, { transient = false } = {}) {
    super(message);
    this.name = 'DeliveryTransportError';
    this.code = code;
    this.transient = transient;
  }
}

/** `v2=<hex>` signature over `${timestamp}.${body}`. */
export function signBody(secret, timestamp, body) {
  const hex = crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${body}`).digest('hex');
  return `v2=${hex}`;
}

/** Default HTTP transport: POST JSON, no redirects, bounded time. */
async function fetchTransport({ url, body, headers }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(env.delivery.timeoutMs),
    });
  } catch {
    throw new DeliveryTransportError('NETWORK_ERROR', 'Destination could not be reached', { transient: true });
  }
  return { status: res.status };
}

let httpTransport = fetchTransport;

/** Test hook: replace the HTTP leg (`async ({ url, body, headers }) => ({ status })`). */
export function setHttpTransport(fn) { httpTransport = fn || fetchTransport; }

/** Throws a typed permanent error when the URL is not an allowed https endpoint. */
export async function assertDestinationUrl(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch {
    throw new DeliveryTransportError('INVALID_URL', 'Destination URL is invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new DeliveryTransportError('INVALID_URL', 'Destination URL must be https without credentials');
  }
  try {
    await assertEgressAllowed([{ host: parsed.hostname.replace(/^\[|\]$/g, ''), port: parsed.port ? Number(parsed.port) : 443 }], { allowPrivate: env.delivery.allowPrivateNetworks });
  } catch {
    throw new DeliveryTransportError('EGRESS_BLOCKED', 'Destination host is not allowed');
  }
}

/** Body for a destination type. */
export function formatBody(type, { kind, deliveryId, title, text, data }) {
  if (type === 'slack') return JSON.stringify({ text: title ? `*${title}*\n${text ?? ''}` : String(text ?? '') });
  if (type === 'teams') return JSON.stringify({ title: title || undefined, text: String(text ?? '') });
  return JSON.stringify({ event: kind, deliveryId, title, text, data: data ?? null, sentAt: new Date().toISOString() });
}

/**
 * Send one notification to a destination. Resolves on 2xx; throws a
 * DeliveryTransportError otherwise (5xx / 429 / network are transient).
 */
export async function send({ type, url, secret, body }) {
  await assertDestinationUrl(url);
  const headers = {};
  if (type === 'webhook' && secret) {
    const ts = Math.floor(Date.now() / 1000);
    headers[TIMESTAMP_HEADER] = String(ts);
    headers[SIGNATURE_HEADER] = signBody(secret, ts, body);
  }
  const { status } = await httpTransport({ url, body, headers });
  if (status >= 200 && status < 300) return { status };
  const transient = status >= 500 || status === 429 || status === 408;
  throw new DeliveryTransportError(`HTTP_${status}`, `Destination answered HTTP ${status}`, { transient });
}

export default { send, signBody, formatBody, assertDestinationUrl, setHttpTransport, DeliveryTransportError };
