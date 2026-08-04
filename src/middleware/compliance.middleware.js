/**
 * compliance.middleware.js (architecture placeholder).
 *
 * PURPOSE
 *   Reads "data subject" status from the compliance store and applies
 *   it to business requests: if a user requested restriction or
 *   erasure, the middleware annotates downstream services so they can
 *   short-circuit (e.g. skip webhook fan-out) without each module
 *   re-checking.
 *
 * RESPONSIBILITY (planned, NO implementation yet)
 *   - Check `governance/compliance` for any active request on the
 *     actor / resource.
 *   - Annotate `req.compliance = { restricted, deleted, inProgress }`.
 *   - Provide a `blockIfDeleted` variant that returns 410 when the
 *     subject is in `deletion_pending` state.
 *
 * PHASE 1.2 BEHAVIOUR
 *   Fails closed with 501 when invoked.
 *
 * USAGE
 *   ```
 *   router.get('/users/:id',
 *     compliance.annotate,                 // adds req.compliance
 *     compliance.blockIfDeleted,           // 410 if applicable
 *     userController.get);
 *   ```
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

/** Annotates the request with the subject's compliance status. */
export const annotate = notImplementedStub('middleware.compliance.annotate');

/** 410 Gone when the subject is in `deletion_pending` state. */
export const blockIfDeleted = notImplementedStub('middleware.compliance.blockIfDeleted');

/** 423 Locked when the subject has requested processing restriction. */
export const blockIfRestricted = notImplementedStub('middleware.compliance.blockIfRestricted');

export default {
  annotate,
  blockIfDeleted,
  blockIfRestricted,
  _meta: {
    phase: '1.2 - fail-closed placeholder',
    seeAlso: [
      'src/services/compliance.service.js',
      'src/routes/compliance.routes.js',
    ],
  },
};
