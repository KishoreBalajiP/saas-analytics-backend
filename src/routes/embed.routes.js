/**
 * Embed routes (shell).
 *
 * WHY IT EXISTS
 *   Reserve the `/embed` surface for the future public widget feature
 *   (signed URLs / tokens that let external sites render dashboards without
 *   an account).
 *
 * RESPONSIBILITY
 *   None yet - router is intentionally empty (404 until implemented).
 *
 * HOW TO EXTEND
 *   Build the feature under `src/modules/embed/`. Embeddable widgets are
 *   public by design, so this router will need its own lightweight signing
 *   middleware and relaxed CORS/CSP review (see config/cors.js notes).
 */

import { Router } from 'express';

const router = Router();

// Embed endpoints will be registered here.

export default router;
