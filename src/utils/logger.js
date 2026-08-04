/**
 * Logger re-export for the rest of the codebase.
 *
 * WHY IT EXISTS
 *   The logger instance is created in `config/logger.js`; this module is the
 *   single import point used everywhere else, plus a small helper for
 *   request-scoped child loggers.
 *
 * RESPONSIBILITY
 *   Re-export the Pino instance and provide `createChildLogger` so modules
 *   can attach bindings (e.g. `{ tenantId, userId }`) without importing
 *   config internals.
 *
 * HOW TO EXTEND
 *   Prefer `req.log` inside request context (set by requestId middleware).
 *   For services outside a request, use `createChildLogger({ ... })`.
 */

import logger from '../config/logger.js';

export const createChildLogger = (bindings = {}) => logger.child(bindings);

export default logger;
