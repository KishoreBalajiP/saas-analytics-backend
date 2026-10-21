/**
 * /api/v1/billing/webhook routes (Phase 6.1 - Razorpay).
 *
 * PURPOSE
 *   Signature-verified Razorpay webhook ingestion. When the provider is
 *   disabled every write returns 501 honestly (preserves the Phase 6
 *   contract); when enabled, webhooks are verified against the RAW body,
 *   durably recorded, and processed idempotently through the billing
 *   lifecycle service.
 *
 * ENDPOINTS
 *   - GET  /health        provider adapter liveness
 *   - POST /              Razorpay webhook (public, signature-gated)
 *
 * SECURITY
 *   - Public route by design (Razorpay signs, we verify). NO state
 *     changes before `X-Razorpay-Signature` verifies against the exact
 *     raw bytes (`express.raw` in `app.js` for this path).
 *   - Missing/invalid signature -> 401, nothing stored (generic message).
 *   - billing (roadmap 3.1): the handler only verifies, stores ONE row per
 *     `x-razorpay-event-id` (unique index) and answers 200 at once; the
 *     event is processed from the stored row off the request path and
 *     retried by the reconcile job (`billingWebhook.service.js`). A
 *     redelivery answers 200 `duplicate` and is never applied twice.
 *   - A failure to STORE the event answers 503 so Razorpay redelivers.
 *   - Supported events are allowlisted in the adapter; other signed
 *     events are stored and acknowledged without mutation.
 *   - Nothing secret is logged or stored (no signatures, no full
 *     payloads - only redacted event summaries).
 */

import { Router } from 'express';
import ApiError from '../utils/ApiError.js';
import config from '../config/env.js';
import { getProvider } from '../services/paymentProvider.adapter.js';
import billingWebhookService, { EVENT_ID_HEADER } from '../services/billingWebhook.service.js';
import logger from '../utils/logger.js';

const router = Router();

router.get( // ci:routes-exempt: public health, no auth
  '/health',
  (_req, res) => {
    const provider = getProvider(config?.razorpay?.enabled ? 'razorpay' : 'noop');
    const implemented = provider.isImplemented === true;
    res.json({
      status: 'ok',
      provider: provider.name,
      implemented,
      environment: implemented ? (config?.razorpay?.environment ?? 'test') : null,
      note: implemented
        ? `Razorpay webhook ingestion is active (${config?.razorpay?.environment ?? 'test'} mode).`
        : 'No payment provider is selected. Webhook and checkout return 501.',
    });
  },
);

router.post( // ci:routes-exempt: public webhook - X-Razorpay-Signature verified below
  '/',
  async (req, res, next) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : null;
      const signature = req.headers?.['x-razorpay-signature'] ?? null;
      const { eventId, duplicate, event, supported } = await billingWebhookService.ingest({
        rawBody: raw,
        signature,
        eventIdHeader: req.headers?.[EVENT_ID_HEADER] ?? null,
      });
      // A redelivery of an event that is still unfinished nudges processing
      // again; a finished one is a no-op.
      if (!duplicate || (event.status !== 'processed' && event.status !== 'ignored')) {
        // Not awaited: the response goes out while processing runs.
        billingWebhookService.kick(event._id);
      }
      return res.json({
        received: true,
        eventId,
        duplicate,
        ...(duplicate ? { reason: 'duplicate_delivery' } : {}),
        ...(supported ? {} : { reason: 'unsupported_event' }),
      });
    } catch (err) {
      if (err instanceof ApiError && [400, 401, 501].includes(err.statusCode)) return next(err);
      // Could not store the event: 503 so Razorpay redelivers it.
      logger.warn({ err: { message: err?.message }, op: 'billing.webhook' }, 'Webhook ingestion failed transiently');
      return next(ApiError.serviceUnavailable('Webhook processing failed; please retry'));
    }
  },
);

export default router;
