/**
 * modulePermission.middleware.js (architecture placeholder).
 *
 * PURPOSE
 *   Coarse-grained module visibility check. Useful for menu rendering
 *   and for routes that have multiple actions (a wildcard on a module)
 *   rather than a single (module, action).
 *
 * RESPONSIBILITY (planned, NO implementation yet)
 *   - Verify the actor has AT LEAST ONE permission on the named module.
 *   - Use case: "show the Platform nav to anyone who can do anything on
 *     `platform`".
 *
 * USAGE
 *   ```
 *   router.use(modulePermission('platform'));
 *   ```
 *
 * PHASE 1.2 BEHAVIOUR
 *   Fails closed with 501 when invoked. Routes do not mount this yet.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const modulePermission = notImplementedStub('middleware.modulePermission');

export default {
  modulePermission,
  _meta: {
    phase: '1.2 - fail-closed placeholder',
    relationship: 'composes with permission.middleware for fine-grained checks',
  },
};
