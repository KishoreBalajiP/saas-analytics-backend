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
import { redactUrl } from '../utils/redact.js';

export function notFoundHandler(req, _res, next) {
  if (req.log) {
    req.log.warn({ method: req.method, url: redactUrl(req.originalUrl) }, 'Route not found');
  }
  // The path is echoed without its query string or any token segment.
  next(ApiError.notFound(`Route not found: ${req.method} ${redactUrl(String(req.originalUrl ?? '').split('?')[0])}`));
}
