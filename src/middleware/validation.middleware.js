/**
 * Validation middleware.
 *
 * WHY IT EXISTS
 *   Thin middleware-facing alias over the schema engine in
 *   `src/validators/index.js`, so route files import a middleware-looking
 *   name. Keeps the "validators" and "middleware" layers decoupled.
 *
 * RESPONSIBILITY
 *   Re-export `validate` as `validateRequest` for use in routes, e.g.:
 *   `router.post('/', validateRequest({ body: { email: 'email|required' } }), ctrl.create)`.
 */

export { validate as validateRequest } from '../validators/index.js';
