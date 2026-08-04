/**
 * ApiError - operational error type for the whole API.
 *
 * WHY IT EXISTS
 *   Express has no opinion on error shapes. A single error type lets the
 *   global error middleware format every failure consistently and lets
 *   controllers throw rich, machine-readable errors in one line.
 *
 * RESPONSIBILITY
 *   Carry an HTTP status, a human message, a machine-readable `code` and
 *   optional structured field errors. `isOperational` separates expected
 *   (4xx/5xx from our code) from unexpected (programmer) errors.
 *
 * HOW TO EXTEND
 *   Use the static factories; add new ones only when you need a new status
 *   combination. Do NOT attach stack traces here - the error middleware
 *   decides when to expose them.
 */

import { ERROR_CODES } from '../config/constants.js';

class ApiError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = options.code ?? ERROR_CODES.INTERNAL_ERROR;
    this.errors = options.errors ?? null;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = 'Bad request', errors) {
    return new ApiError(400, message, { code: ERROR_CODES.BAD_REQUEST, errors });
  }

  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, message, { code: ERROR_CODES.UNAUTHORIZED });
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new ApiError(403, message, { code: ERROR_CODES.FORBIDDEN });
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, message, { code: ERROR_CODES.NOT_FOUND });
  }

  static conflict(message = 'Resource conflict') {
    return new ApiError(409, message, { code: ERROR_CODES.CONFLICT });
  }

  static validation(message = 'Validation failed', errors) {
    return new ApiError(422, message, { code: ERROR_CODES.VALIDATION_FAILED, errors });
  }

  static tooManyRequests(message = 'Too many requests, please slow down') {
    return new ApiError(429, message, { code: ERROR_CODES.RATE_LIMITED });
  }

  static notImplemented(message = 'This feature is not implemented yet') {
    return new ApiError(501, message, { code: ERROR_CODES.NOT_IMPLEMENTED });
  }

  static serviceUnavailable(message = 'Service temporarily unavailable') {
    return new ApiError(503, message, { code: ERROR_CODES.SERVICE_UNAVAILABLE });
  }

  static internal(message = 'Internal server error') {
    return new ApiError(500, message, { code: ERROR_CODES.INTERNAL_ERROR, isOperational: false });
  }
}

export default ApiError;
