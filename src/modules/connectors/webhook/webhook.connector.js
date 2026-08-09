/**
 * WebhookConnector - inbound event ingestion provider (Sprint 4).
 *
 * WHY IT EXISTS
 *   Implements the `BaseConnector` contract for inbound webhooks: config
 *   validation (HMAC signing secret) and payload normalisation into a
 *   uniform list of source records. Signature verification lives in
 *   `webhook.verify.js` and is applied at the HTTP edge; the connector only
 *   normalises already-trusted payloads.
 *
 * CONFIG (SECRET - stored encrypted at rest):
 *   { signingSecret: string, toleranceSeconds?: number, requireTimestamp?: boolean }
 *
 * PAYLOAD SHAPES ACCEPTED (see `ingest`)
 *   - a JSON array of events
 *   - an object with an `events` array
 *   - an object with a `data` array
 *   - a single event object
 *
 * CODING GUIDELINES
 *   - No persistent connection: `connect` / `disconnect` are no-ops.
 *   - `ingest` returns an ARRAY (webhook payloads are bounded); the sync
 *     engine accepts arrays and async iterables alike.
 */

import BaseConnector from '../../../connectors/BaseConnector.js';
import { validateConfig } from '../shared/validators.js';

export class WebhookConnector extends BaseConnector {
  static type = 'webhook';
  static displayName = 'Inbound Webhook';
  static description = 'Receive HMAC-verified provider events as connector rows.';
  static capabilities = ['validate', 'ingest'];

  async connect() {
    this.connected = true;
  }

  /** Validate the stored webhook config (signingSecret, tolerance). */
  async validate() {
    const { valid, errors } = validateConfig('webhook', this.config);
    return { valid, errors };
  }

  /**
   * Normalise a parsed webhook payload into an array of source records.
   *
   * @param {Object} [options]
   * @param {*} options.payload - parsed JSON body (already HMAC-verified).
   * @returns {Promise<Object[]>} raw source records for the sync engine.
   */
  async ingest({ payload } = {}) {
    if (payload === null || payload === undefined) return [];
    if (Array.isArray(payload)) return payload;
    if (typeof payload !== 'object') return [{ value: payload }];
    if (Array.isArray(payload.events)) return payload.events;
    if (Array.isArray(payload.data)) return payload.data;
    return [payload];
  }

  async disconnect() {
    this.connected = false;
  }
}

export default WebhookConnector;
