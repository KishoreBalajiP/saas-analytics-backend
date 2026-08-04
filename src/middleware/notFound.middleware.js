/**
 * Central 404 handler.
 *
 * WHY IT EXISTS
 *   Every unmatched route returns the same JSON error shape through the
 *   global error pipeline, so clients can rely on one contract.
 *
 * RESPONSIBILITY
 *   Convert "no route matched" into a 404 ApiError (which the error
 *   middleware formats), while logging the attempted path.
 *
 * HOW TO EXTEND
 *   Nothing - mount it AFTER all routes. If the API prefix changes, nothing
 *   here changes.
 */

import ApiError from '../utils/ApiError.js';

export function notFoundHandler(req, _res, next) {
  if (req.log) {
    req.log.warn({ method: req.method, url: req.originalUrl }, 'Route not found');
  }
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}
