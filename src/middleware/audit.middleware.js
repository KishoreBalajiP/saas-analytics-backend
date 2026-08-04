/**
 * audit.middleware.js (architecture placeholder).
 *
 * PURPOSE
 *   Records every state-mutating request into `governance/audit-logs/`.
 *   Does not check permissions; only observes. Sensitive payloads are
 *   redacted by `services/auditLog.service#emit` before persistence.
 *
 * RESPONSIBILITY (planned, NO implementation yet)
 *   - Capture actor, action (from verb), module (from route prefix),
 *     before/after (via service layer diff), reason (from body), ip,
 *     userAgent, requestId, result.
 *   - Emit AFTER the route handler finishes (success OR failure).
 *   - Always emit at least one row even when the call is refused, so
 *     the refusal itself is auditable.
 *
 * PHASE 1.2 BEHAVIOUR
 *   Fails closed with 501 when invoked.
 *
 * USAGE
 *   ```
 *   router.post(
 *     '/:id/suspend',
 *     audit('iam.admins', 'suspend'),       // captures reason from req.body
 *     controller.suspendAdmin
 *   );
 *   ```
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

/**
 * Factory: returns middleware that audits the request.
 * Phase 1.2 returns 501; Phase 2 returns the real audit capture.
 */
export const audit = notImplementedStub('middleware.audit');

export default {
  audit,
  _meta: {
    phase: '1.2 - fail-closed placeholder',
    seeAlso: [
      'src/services/auditLog.service.js',
      'src/routes/audit-log.routes.js',
    ],
  },
};
