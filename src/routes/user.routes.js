/**
 * User routes (shell).
 *
 * WHY IT EXISTS
 *   Reserve the `/users` surface for the future user management feature
 *   (profiles, roles, memberships, invites).
 *
 * RESPONSIBILITY
 *   None yet - router is intentionally empty (404 until implemented).
 *
 * HOW TO EXTEND
 *   Build the feature under `src/modules/users/` and wire endpoints, e.g.:
 *   ```
 *   router.use(authenticate);
 *   router.get('/me', userController.me);
 *   router.get('/:userId', userController.getById);
 *   router.patch('/:userId', validateRequest(updateUserSchema), userController.update);
 *   ```
 */

import { Router } from 'express';

const router = Router();

// User endpoints will be registered here.

export default router;
