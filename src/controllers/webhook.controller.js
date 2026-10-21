/**
 * Webhook Controller (Sprint 4 - implemented).
 *
 * WHY IT EXISTS
 *   HTTP layer for the PUBLIC inbound surface `POST /api/v1/webhooks/:webhookToken`.
 *   This endpoint must NOT require tenant auth - providers can't know JWTs.
 *   Trust comes entirely from the HMAC-SHA256 signature verified by the
 *   connector service (fail closed: bad/absent signature -> 401).
 *
 * RESPONSIBILITY
 *   Forward the raw body + headers to `connectorService.handleWebhook` and
 *   acknowledge with 202 (accepted for processing). The service runs every
 *   cheap pre-check (content type, size, connector / tenant state, header
 *   format, timestamp window) before the signing key is touched.
 *
 * SECURITY NOTES
 *   - The router mounts `express.raw({ type: '*\\/*' })` (in `app.js`, before
 *     JSON parsing) so `req.body` is the exact Buffer the signature covers.
 *   - Never log the payload or signature here.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import connectorService from '../services/connector.service.js';

/**
 * POST /api/v1/webhooks/:webhookToken - receive a provider event.
 *
 * A delivery accepted with the legacy body-only signature is flagged with a
 * `Deprecation: true` header so senders notice before the legacy scheme is
 * switched off.
 */
export const receive = asyncHandler(async (req, res) => {
  const result = await connectorService.handleWebhook({
    webhookToken: req.params.webhookToken,
    rawBody: Buffer.isBuffer(req.body) ? req.body : undefined,
    headers: req.headers,
  });
  if (result.signatureVersion === 1) res.set('Deprecation', 'true');
  return ApiResponse.accepted(res, result, 'Webhook accepted');
});

export default { receive };
