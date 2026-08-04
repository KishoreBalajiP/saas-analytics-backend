/**
 * Rate limiter middleware.
 *
 * WHY IT EXISTS
 *   Protects the API from abuse and accidental client bugs with a sliding
 *   window limit per IP, configured entirely through environment variables.
 *
 * RESPONSIBILITY
 *   - Apply a global per-IP limit to all API routes (health excluded so
 *     load balancers can probe freely).
 *   - Provide a factory for stricter per-feature limits (e.g. auth login).
 *   - Return a consistent 429 ApiResponse shape on over-limit.
 *
 * HOW TO EXTEND
 *   Create per-endpoint limiters with `createRateLimiter({ windowMs, limit })`
 *   and mount them inside specific routers. `RATE_LIMIT_STRICT_MAX` exists
 *   for exactly that.
 */

import { rateLimit } from 'express-rate-limit';
import env from '../config/env.js';

const standardHandler = (req, res) => {
  if (req.log) {
    req.log.warn({ ip: req.ip }, 'Rate limit exceeded');
  }
  res.status(429).json({
    success: false,
    statusCode: 429,
    message: 'Too many requests, please try again later.',
    code: 'RATE_LIMITED',
    timestamp: new Date().toISOString(),
  });
};

/** Shared defaults so every limiter behaves consistently. */
const baseOptions = {
  windowMs: env.security.rateLimit.windowMs,
  limit: env.security.rateLimit.max,
  standardHeaders: true, // send `RateLimit-*` (draft-7) headers
  legacyHeaders: false, // drop the deprecated `X-RateLimit-*` headers
  skip: (req) => req.path === '/health' || req.path.startsWith('/health'),
  handler: standardHandler,
};

/** Global API limiter applied to every request under the API prefix. */
export const apiLimiter = rateLimit(baseOptions);

/** Factory for stricter, feature-specific limiters. */
export function createRateLimiter({ windowMs, limit, skip } = {}) {
  return rateLimit({
    ...baseOptions,
    windowMs: windowMs ?? env.security.rateLimit.windowMs,
    limit: limit ?? env.security.rateLimit.strictMax,
    skip,
    handler: standardHandler,
  });
}

/** Reserved for the future auth routes (login/register brute-force guard). */
export const strictLimiter = createRateLimiter({
  windowMs: env.security.rateLimit.windowMs,
  limit: env.security.rateLimit.strictMax,
});
