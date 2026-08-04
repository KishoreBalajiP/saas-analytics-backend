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
}

export default ApiResponse;
