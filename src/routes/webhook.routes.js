/**
 * /api/v1/webhooks routes (Sprint 4 - implemented).
 *
 * WHY IT EXISTS
 *   Public inbound surface for provider webhooks. There is NO tenant auth
 *   here - external systems cannot hold JWTs. Trust is established purely by
 *   the HMAC-SHA256 signature the service verifies against the connector's
 *   decrypted `signingSecret` (fail closed: 401 on any mismatch).
 *
 * ENDPOINTS
 *   - POST /:webhookToken    - receive + verify + enqueue a provider event
 *
 * SECURITY NOTES
 *   - The raw body parser is mounted in `app.js` BEFORE `express.json`, so
 *     `req.body` is the exact Buffer the signature was computed over.
 *   - Responses are 202 (accepted for async processing) or 401/422.
 *   - Never log webhook payloads or signatures.
 */

import { Router } from 'express';
import webhookController from '../controllers/webhook.controller.js';

const router = Router();

router.post('/:webhookToken', webhookController.receive);

export default router;
