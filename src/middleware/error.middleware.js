/**
 * Global error handler middleware.
 *
 * WHY IT EXISTS
 *   One place converts every error - operational, Mongoose, body-parser or
 *   unexpected - into the standard error envelope. Clients always get a
 *   consistent shape, and stack traces are never leaked in production.
 *
 * RESPONSIBILITY
 *   - Map well-known error types to the right status/code.
 *   - Log 5xx with full context, 4xx as warnings.
 *   - Reply with the standard `{ success: false, ... }` envelope.
 *
 * HOW TO EXTEND
 *   Add new `if` branches for error types the team introduces (e.g. Redis,
 *   external API timeouts). Always end with the 500 fallback.
 */

import mongoose from 'mongoose';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import { ERROR_CODES } from '../config/constants.js';

function toApiError(err) {
  // Already an operational API error.
  if (err instanceof ApiError) return err;

  // Mongoose schema validation errors.
  if (err instanceof mongoose.Error.ValidationError) {
    const errors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return ApiError.validation('Request validation failed', errors);
  }

  // Mongoose invalid cast (e.g. bad ObjectId in a query param).
  if (err instanceof mongoose.Error.CastError) {
    return ApiError.badRequest(`Invalid value for field "${err.path}"`, [
      { field: err.path, message: err.message },
    ]);
  }

  // MongoDB duplicate key (e.g. unique email).
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'field';
    return ApiError.conflict(`A record with that ${field} already exists`);
  }

  // Body parser: malformed JSON body.
  if (err instanceof SyntaxError && err.type === 'entity.parse.failed') {
    return ApiError.badRequest('Malformed JSON in request body');
  }

  // Body parser: payload exceeds configured limit.
  if (err.type === 'entity.too.large') {
    return new ApiError(413, 'Request body too large', { code: 'PAYLOAD_TOO_LARGE' });
  }

  // Unsupported content encoding.
  if (err.type === 'encoding.unsupported') {
    return ApiError.badRequest('Unsupported content encoding');
  }

  // Unknown error - do not leak internal details to clients.
  return ApiError.internal();
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const error = toApiError(err);
  const isServerError = error.statusCode >= 500;

  // Logging: full context for 5xx, warning-level for expected 4xx.
  const logContext = {
    err: { name: err.name, message: err.message, stack: err.stack },
    method: req.method,
    url: req.originalUrl,
    statusCode: error.statusCode,
    requestId: req.id,
  };
  if (isServerError) {
    (req.log ?? console).error(logContext, 'Unhandled error');
  } else {
    (req.log ?? console).warn(logContext, 'Request failed');
  }

  const payload = {
    success: false,
    statusCode: error.statusCode,
    message: error.message,
    code: error.code ?? ERROR_CODES.INTERNAL_ERROR,
    timestamp: new Date().toISOString(),
  };

  if (error.errors) payload.errors = error.errors;

  // Structured hint for the client, e.g. an admin login that must retry
  // with a TOTP code (`mfaRequired: true` on a 401).
  if (error.mfaRequired !== undefined) payload.mfaRequired = error.mfaRequired;

  // Show stack only outside production (never expose internals to clients).
  if (!env.app.isProduction && isServerError && err.stack) {
    payload.stack = err.stack;
  }

  res.status(error.statusCode).json(payload);
}
