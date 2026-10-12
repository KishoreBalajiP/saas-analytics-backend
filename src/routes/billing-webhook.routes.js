/**
 * /api/v1/billing/webhook routes (Phase 6 - implemented, 501 only).
 *
 * PURPOSE
 *   The payment-provider webhook integration boundary. Phase 6 ships
 *   this as a 501 stub that documents the contract a future provider
 *   must satisfy. The route is intentionally public (no auth) because
 *   webhooks are signed by the provider; the route layer is
 *   responsible for signature verification using the provider's
 *   official mechanism BEFORE the body reaches the service.
 *
 * ENDPOINTS
 *   - GET  /health        provider adapter liveness
 *   - POST /              provider webhook (501 in Phase 6, notImplemented)
 *
 * SECURITY
 *   - This route is NOT auth-gated. A future provider MUST verify the
 *     signature on the raw body before any state change. Phase 6
 *     returns 501 BEFORE the signature is checked, so no payload
 *     ever reaches a handler.
 *   - Rate limiting is the responsibility of the platform
 *     reverse-proxy; this route does not impose its own limit so a
 *     future provider's burst pattern is not artificially capped.
 *   - The `ci:routes-exempt` annotation sits on the `router.<verb>(`
 *     line itself so the `check-routes` CI guard sees it inside the
 *     captured args; this is a public 501 surface by design.
 */

import { Router } from 'express';
import ApiError from '../utils/ApiError.js';
import { listProviders } from '../services/paymentProvider.adapter.js';

const router = Router();

router.get( // ci:routes-exempt: public health, no auth
  '/health',
  (_req, res) => {
    res.json({
      status: 'ok',
      provider: 'noop',
      providers: listProviders(),
      implemented: false,
      note: 'No payment provider is selected. Webhook and checkout return 501.',
    });
  },
);

router.post( // ci:routes-exempt: 501 stub - no provider selected
  '/',
  (_req, _res, next) => {
    next(
      ApiError.notImplemented(
        'No payment provider is selected. Webhook ingestion is not yet available.',
      ),
    );
  },
);

export default router;
