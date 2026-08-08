/**
 * ApiResponse - consistent success envelope for every API response.
 *
 * WHY IT EXISTS
 *   Guarantees the client always receives the same JSON shape, which makes
 *   SDKs and frontend API clients trivial to build and keeps the wire
 *   contract stable as the team grows.
 *
 * RESPONSIBILITY
 *   Build `{ success, statusCode, message, data, meta, timestamp }` envelopes
 *   and send them with the correct HTTP status.
 *
 * HOW TO EXTEND
 *   Add optional helpers (e.g. `paginated`) when pagination lands. Keep the
 *   envelope shape versioned - changing it is a breaking API change.
 */

import { ERROR_CODES, HTTP_STATUS } from '../config/constants.js';

class ApiResponse {
  constructor(statusCode, data = null, message = 'Success', meta) {
    this.success = true;
    this.statusCode = statusCode;
    this.message = message;
    this.data = data;
    this.meta = meta;
    this.timestamp = new Date().toISOString();
  }

  /**
   * Send the envelope. Returns the response for chaining convenience.
   */
  static send(res, statusCode, data = null, message = 'Success', meta) {
    return res.status(statusCode).json(new ApiResponse(statusCode, data, message, meta));
  }

  static ok(res, data = null, message = 'Success', meta) {
    return ApiResponse.send(res, 200, data, message, meta);
  }

  static created(res, data = null, message = 'Created', meta) {
    return ApiResponse.send(res, 201, data, message, meta);
  }

  static accepted(res, data = null, message = 'Accepted', meta) {
    return ApiResponse.send(res, 202, data, message, meta);
  }

  static noContent(res) {
    return res.status(204).send();
  }

  /**
   * Send a failure-shaped envelope directly from a handler (used for
   * deliberate non-throwing responses, e.g. 501 feature stubs). Most
   * failures should instead `throw ApiError` so the global error handler
   * formats them identically.
   */
  static error(res, statusCode = HTTP_STATUS.BAD_REQUEST, message = 'Error', code) {
    return res.status(statusCode).json({
      success: false,
      statusCode,
      message,
      code: code ?? ERROR_CODE_FOR_STATUS[statusCode] ?? ERROR_CODES.INTERNAL_ERROR,
      timestamp: new Date().toISOString(),
    });
  }
}

/** Default machine-readable code for a status when none is supplied. */
const ERROR_CODE_FOR_STATUS = {
  [HTTP_STATUS.BAD_REQUEST]: ERROR_CODES.BAD_REQUEST,
  [HTTP_STATUS.UNAUTHORIZED]: ERROR_CODES.UNAUTHORIZED,
  [HTTP_STATUS.FORBIDDEN]: ERROR_CODES.FORBIDDEN,
  [HTTP_STATUS.NOT_FOUND]: ERROR_CODES.NOT_FOUND,
  [HTTP_STATUS.CONFLICT]: ERROR_CODES.CONFLICT,
  [HTTP_STATUS.UNPROCESSABLE_ENTITY]: ERROR_CODES.VALIDATION_FAILED,
  [HTTP_STATUS.TOO_MANY_REQUESTS]: ERROR_CODES.RATE_LIMITED,
  [HTTP_STATUS.NOT_IMPLEMENTED]: ERROR_CODES.NOT_IMPLEMENTED,
  [HTTP_STATUS.SERVICE_UNAVAILABLE]: ERROR_CODES.SERVICE_UNAVAILABLE,
};

export default ApiResponse;
