/**
 * Raw body parser for the public webhook surface.
 *
 * WHY IT EXISTS
 *   Webhook signatures are computed over the EXACT request bytes, so the
 *   webhook path is buffered with `express.raw` before the JSON parser (see
 *   `app.js`). The buffer is capped at `WEBHOOK_MAX_BODY_KB`; this wrapper
 *   turns the parser's generic "entity too large" failure into the typed
 *   `413 WEBHOOK_PAYLOAD_TOO_LARGE` the webhook contract documents. The
 *   body is refused while it is being read, long before any connector
 *   lookup or key derivation.
 */

import express from 'express';
import env from '../../../config/env.js';
import { ConnectorError, CONNECTOR_ERROR_CODES } from '../shared/errors.js';

/** Typed 413 for an oversize webhook body. */
export function webhookPayloadTooLarge(maxBodyBytes = env.connectors.webhook.maxBodyBytes) {
  return new ConnectorError(
    CONNECTOR_ERROR_CODES.WEBHOOK_PAYLOAD_TOO_LARGE,
    `Webhook bodies are limited to ${Math.floor(maxBodyBytes / 1024)} KB.`,
    { statusCode: 413 },
  );
}

let parser = null;
let parserLimit = null;

function rawParser(limit) {
  if (!parser || parserLimit !== limit) {
    parser = express.raw({ type: '*/*', limit });
    parserLimit = limit;
  }
  return parser;
}

/** Express middleware: buffer the raw webhook body (bounded, typed 413). */
export function webhookRawBody(req, res, next) {
  const limit = env.connectors.webhook.maxBodyBytes;
  return rawParser(limit)(req, res, (err) => {
    if (err && err.type === 'entity.too.large') return next(webhookPayloadTooLarge(limit));
    return next(err);
  });
}

export default webhookRawBody;
