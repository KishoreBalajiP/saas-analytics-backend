/**
 * /api/v1/compliance routes - Data-subject requests and evidence.
 *
 * WHY IT EXISTS
 *   Centralised place to file and resolve GDPR/CCPA-style requests
 *   (export, delete, restrict, consent withdraw). Even "no data found"
 *   produces a compliance audit entry (proof of search). Backed by
 *   `governance/compliance/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - POST   /requests              - data subject (or admin) files request
 *   - GET    /requests              - list (admin-only)
 *   - GET    /requests/:id          - status + evidence
 *   - POST   /requests/:id/cancel   - cancel before start
 *   - POST   /public/requests       - subject-facing entry (signed token)
 *   - GET    /public/requests/:id   - subject polls status
 *
 * HOW TO EXTEND
 *   - Internal `/requests` requires `compliance.configure` permission.
 *   - External endpoints accept a signed token instead of bearer auth.
 *   - Every state change emits `audit.middleware.js` entry, including
 *     "no data found" rejections.
 */

import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';

const router = Router();

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    res.status(501).json({
      success: false,
      statusCode: 501,
      message: `${op} is not implemented yet (Phase 1.2 architecture placeholder)`,
      hint: 'See src/modules/governance/compliance/README.md',
    });
  });

// Internal (admin-gated)
router.post('/requests', notImplemented('POST /compliance/requests'));
router.get('/requests', notImplemented('GET /compliance/requests'));
router.get('/requests/:id', notImplemented('GET /compliance/requests/:id'));
router.post('/requests/:id/cancel', notImplemented('POST /compliance/requests/:id/cancel'));

// Public subject-facing (signed token)
router.post('/public/requests', notImplemented('POST /compliance/public/requests'));
router.get('/public/requests/:id', notImplemented('GET /compliance/public/requests/:id'));

export default router;
