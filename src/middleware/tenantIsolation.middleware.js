/**
 * tenantIsolation.middleware.js (architecture placeholder).
 *
 * PURPOSE
 *   Strict enforcement of the multi-tenant boundary. Runs AFTER `adminAuth`
 *   (or tenant `auth`) and AFTER `tenant.middleware.js` (which resolves
 *   `req.tenantId`). Refuses any request that accesses cross-tenant data
 *   without an explicit `tenantScope: '*'` flag.
 *
 * RESPONSIBILITY (planned, NO implementation yet)
 *   - Compare `req.params.tenantId` / `req.body.tenantId` with `req.actor.scopes`.
 *   - Refuse 403 when the actor lacks `tenantScope: '*'` and the requested
 *     tenantId is not in the actor's granted list.
 *   - Provide opt-out for support admins via a typed header.
 *
 * DESIGN PRINCIPLES
 *   - **Default deny.** No request bypasses unless the actor is a platform
 *     admin OR has explicit cross-tenant scope.
 *   - **Combine with `tenant.middleware.js`.** Resolution (which tenant?)
 *     comes from `tenant.middleware.js`; isolation (can the actor reach
 *     this tenant?) comes from THIS middleware. Two-step split keeps both
 *     single-purpose.
 *
 * PHASE 1.2 BEHAVIOUR
 *   Fails closed with 501 when invoked. Routes do not mount this yet.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const tenantIsolation = notImplementedStub('middleware.tenantIsolation');

/** Variant for queue workers / background jobs that already have a scope. */
export const tenantIsolationForJob = notImplementedStub('middleware.tenantIsolationForJob');

export default {
  tenantIsolation,
  tenantIsolationForJob,
  _meta: {
    phase: '1.2 - fail-closed placeholder',
    runOrder: 'after adminAuth / auth, after tenant.middleware.js',
    seeAlso: ['src/middleware/tenant.middleware.js'],
  },
};
