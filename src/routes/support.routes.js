/**
 * /api/v1/support routes - Internal admin escape hatch.
 *
 * WHY IT EXISTS
 *   Support Admins need a curated surface for impersonation, account
 *   recovery, and cross-tenant lookups - the regular APIs are deliberately
 *   narrow. Every support call is audited AND logged via `access-log`.
 *   Backed by `platform/support/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - POST   /impersonate             - begin impersonation (reason required)
 *   - POST   /impersonate/stop        - end impersonation
 *   - POST   /account/recover         - reset password / unlock
 *   - POST   /account/revoke-sessions - kill all sessions for a user
 *   - GET    /tenants/:id/lookups     - aggregated view
 *   - POST   /notifications/broadcast - one-off cross-tenant announcement
 *
 * HOW TO EXTEND
 *   - Every request MUST carry `reason` in body. Validator rejects 422.
 *   - Impersonation is rate-limited per admin per day.
 *   - Audit + access-log middleware both run (Phase 2).
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
      hint: 'See src/modules/platform/support/README.md',
    });
  });

router.post('/impersonate', notImplemented('POST /support/impersonate'));
router.post('/impersonate/stop', notImplemented('POST /support/impersonate/stop'));
router.post('/account/recover', notImplemented('POST /support/account/recover'));
router.post('/account/revoke-sessions', notImplemented('POST /support/account/revoke-sessions'));
router.get('/tenants/:id/lookups', notImplemented('GET /support/tenants/:id/lookups'));
router.post('/notifications/broadcast', notImplemented('POST /support/notifications/broadcast'));

export default router;
