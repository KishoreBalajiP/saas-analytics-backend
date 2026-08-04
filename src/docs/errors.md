# Error Envelope Contract

Every error response - whether from a controller, a service, a Mongoose
validation or an unhandled rejection - is funnelled through the global
`errorHandler` middleware and rendered as a consistent envelope.

## Wire Format

```json
{
  "success": false,
  "statusCode": 422,
  "message": "Validation failed",
  "code": "VALIDATION_FAILED",
  "errors": [
    { "field": "email", "message": "must be a valid email address" }
  ],
  "timestamp": "2026-08-04T12:34:56.789Z"
}
```

In development, 5xx errors additionally include `stack`. Stack traces are
**never** returned in production.

## Error Codes

| Code                       | HTTP | When                                                       |
| -------------------------- | ---- | ---------------------------------------------------------- |
| `BAD_REQUEST`              | 400  | Malformed input / CastError                                |
| `UNAUTHORIZED`             | 401  | Missing or invalid credentials                             |
| `FORBIDDEN`                | 403  | Authenticated but not allowed                              |
| `NOT_FOUND`                | 404  | Resource does not exist (or route does not match)          |
| `CONFLICT`                 | 409  | Unique-key violation, version conflict                     |
| `VALIDATION_FAILED`        | 422  | Request payload failed schema validation                   |
| `PAYLOAD_TOO_LARGE`        | 413  | Body exceeds `REQUEST_BODY_LIMIT`                          |
| `RATE_LIMITED`             | 429  | Per-IP / per-account throttle                              |
| `INTERNAL_ERROR`           | 500  | Unexpected programmer error                                |
| `NOT_IMPLEMENTED`          | 501  | Feature is not yet implemented (fail-closed)               |
| `SERVICE_UNAVAILABLE`      | 503  | Cache / DB / external dependency unavailable               |

## How To Throw

Always throw an `ApiError` factory so the central handler can do its job:

```js
import ApiError from '../utils/ApiError.js';

if (!user) throw ApiError.notFound('User not found');
if (!isOwner) throw ApiError.forbidden();
throw ApiError.validation('Invalid input', [{ field: 'email', message: 'required' }]);
```

## How To Add A New Code

1. Add the constant to `src/config/constants.js#ERROR_CODES`.
2. Add a factory to `src/utils/ApiError.js` when you need a new status.
3. Update the catalogue above.

Never invent a `code` value at the call site - always use a factory.
