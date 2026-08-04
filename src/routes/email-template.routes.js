/**
 * /api/v1/email-templates routes - Template registry + preview.
 *
 * WHY IT EXISTS
 *   Centralises transactional email templates: subject, sender, locale-
 *   tagged body. The mail worker resolves variables and dispatches via
 *   `src/config/mail.js`. Backed by `platform/email-templates/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET    /                      - list
 *   - POST   /                      - create
 *   - GET    /:id                   - detail (locale-aware)
 *   - PATCH  /:id                   - update body / subject
 *   - POST   /:id/activate          - flip to active
 *   - POST   /:id/archive           - archive
 *   - POST   /:id/preview           - render with sample data (admin-only)
 *   - GET    /:id/versions          - change history (planned)
 *
 * HOW TO EXTEND
 *   - Templates may not be hard-deleted if a send is in flight.
 *   - Variables are substituted server-side through a safe helper; never
 *     `eval`. `validators/` enforces the variable contract.
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
      hint: 'See src/modules/platform/email-templates/README.md',
    });
  });

router.get('/', notImplemented('GET /email-templates'));
router.post('/', notImplemented('POST /email-templates'));
router.get('/:id', notImplemented('GET /email-templates/:id'));
router.patch('/:id', notImplemented('PATCH /email-templates/:id'));
router.post('/:id/activate', notImplemented('POST /email-templates/:id/activate'));
router.post('/:id/archive', notImplemented('POST /email-templates/:id/archive'));
router.post('/:id/preview', notImplemented('POST /email-templates/:id/preview'));
router.get('/:id/versions', notImplemented('GET /email-templates/:id/versions'));

export default router;
