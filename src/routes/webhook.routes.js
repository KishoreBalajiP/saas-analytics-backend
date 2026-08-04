/**
 * Webhook routes (shell).
 *
 * WHY IT EXISTS
 *   Reserve the `/webhooks` surface for the future webhook feature (inbound
 *   provider events like Google Sheets / Stripe, and outbound notifications).
 *
 * RESPONSIBILITY
 *   None yet - router is intentionally empty (404 until implemented).
 *
 * HOW TO EXTEND
 *   Build the feature under `src/modules/alerts/` or a dedicated webhook
 *   module. Inbound webhooks need signature verification middleware (never
 *   trust them without validating the provider signature) and often a raw
 *   body parser - plan for `express.raw()` here rather than json().
 */

import { Router } from 'express';

const router = Router();

// Webhook endpoints will be registered here.

export default router;
