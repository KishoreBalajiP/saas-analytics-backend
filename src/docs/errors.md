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
  "requestId": "3f1c2b9e-6a52-4d1e-9b0c-1f2e3d4c5b6a",
  "timestamp": "2026-08-04T12:34:56.789Z"
}
```

`requestId` equals the `X-Request-Id` response header (sent on every
response). The frontend shows it as a copyable "Reference ID" so support can
find the request's log lines and its error-tracker event (roadmap 2.8).

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
| `QUOTA_EXCEEDED`           | 409 / 429 | Hard plan limit reached (409 resource counts, 429 daily API calls) |
| `SUBSCRIPTION_WRITE_BLOCKED` | 403 | Subscription is `expired`/`restricted`; creates are refused |
| `EXPORT_EXPIRED`           | 410 | An audit/access-log export or report artefact passed its download window (`RETENTION_EXPORT_DAYS` / `RETENTION_REPORT_ARTIFACT_DAYS`); request a new export |
| `MFA_ENROLLMENT_REQUIRED` | 403 | adminauth: the admin session may only enrol MFA (privileged admin without MFA) |
| `STEP_UP_REQUIRED` | 403 | adminauth: sensitive admin action needs a fresh `POST /admin-auth/step-up` on this session |
| `STEP_UP_FAILED` | 403 | adminauth: re-authentication (password + code) failed; counts toward lockout |
| `EXPORT_IN_PROGRESS`       | 409  | backups: a data export of this workspace is already queued or running (`errors[0].message` = its exportId) |
| `EXPORT_RATE_LIMITED`      | 429  | backups: the workspace reached `TENANT_EXPORT_DAILY_LIMIT` exports in 24 hours |
| `EXPORT_NOT_FOUND`         | 404  | backups: no export with that id in this tenant |
| `EXPORT_NOT_READY`         | 409  | backups: download requested before the export completed |
| `EXPORT_DOWNLOAD_FORBIDDEN` | 403 | backups: a workspace member tried to download an export platform support prepared |
| `DOWNLOAD_LINK_INVALID`    | 401  | backups: forged, altered or malformed signed download link |
| `DOWNLOAD_LINK_EXPIRED`    | 410  | backups: signed download link older than `TENANT_EXPORT_DOWNLOAD_URL_TTL_SECONDS` |
| `TENANT_NOT_FOUND`         | 404  | backups: platform export of an unknown tenant |
| `INTERNAL_ERROR`           | 500  | Unexpected programmer error                                |
| `NOT_IMPLEMENTED`          | 501  | Feature is not yet implemented (fail-closed)               |
| `SERVICE_UNAVAILABLE`      | 503  | Cache / DB / external dependency unavailable               |
| `IMPERSONATION_READ_ONLY`  | 403  | A support session attempted POST/PUT/PATCH/DELETE (support codes live in `src/constants/support.js`) |
| `IMPERSONATION_SESSION_REQUIRED` | 403 | Endpoint only for support sessions (`POST /support-session/end`) |
| `SUPPORT_CONSENT_REQUIRED` | 403  | No active workspace consent or own approved break-glass grant |
| `SUPPORT_TARGET_PROTECTED` | 403  | Support session target is platform staff |
| `BREAK_GLASS_APPROVAL_DENIED` | 403 | Approver is not a different, active, unscoped super admin |
| `SUPPORT_GRANT_NOT_ACTIVE` | 409  | Grant or support session can no longer change state |
| `SUPPORT_IMPERSONATION_CAP_EXCEEDED` | 429 | Per-admin daily support session cap reached |
| `ALERT_METRIC_INVALID`     | 400  | Alert `metric` is not an output of its query (save time, or evaluation after the query changed) |
| `ALERT_TOO_MANY_GROUPS`    | 422  | Per-group (`any`/`all`) alert over more than 5,000 groups  |
| `TOO_MANY_COLUMNS`         | 422  | Report/export of a raw result with more than 2,000 columns  |
| `EXPORT_NOT_READY`         | 409  | Download of an analytics export that is not `ready`        |
| `DOWNLOAD_LINK_INVALID`    | 404  | Signed download link malformed, forged or expired          |

## Plan-Limit Errors

A create that would pass a hard plan limit answers `QUOTA_EXCEEDED` with one
`errors` entry keyed by the metric, so clients can name what ran out:

```json
{
  "statusCode": 409,
  "code": "QUOTA_EXCEEDED",
  "message": "Plan limit reached for dashboards (max 5)",
  "errors": [
    { "field": "dashboards", "message": "Plan limit reached for dashboards (max 5)",
      "metric": "dashboards", "limit": 5, "current": 5, "requested": 1,
      "period": "current", "resetsAt": null }
  ]
}
```

Daily metered metrics (`apiCallsPerDay`) answer 429 with `period` set to the
UTC day, `resetsAt` set to the next midnight UTC, and `Retry-After`,
`X-Quota-Limit`, `X-Quota-Remaining` and `X-Quota-Reset` headers. Soft limits
never refuse. Build the error with `entitlementService.quotaExceededError`.

## Platform Configuration Errors (roadmap 2.4)

Raised by the settings, feature-flag and email-template surfaces
(`services/configHistory.service.js#CONFIG_ERROR_CODES`):

| Code | HTTP | When |
| --- | --- | --- |
| `VERSION_CONFLICT` | 409 | The `version` sent is stale; reload and retry |
| `SETTING_NOT_FOUND` | 404 | Unknown platform setting key |
| `SETTING_READ_ONLY` | 403 | Code-managed setting |
| `SETTING_NOT_SECRET` | 400 | Secret reveal asked for a non-secret key |
| `SECRET_PERMISSION_REQUIRED` | 403 | Writing a secret without `settings.secrets.update` |
| `REVISION_NOT_FOUND` | 404 | Rollback target version not in the history |
| `FEATURE_FLAG_NOT_FOUND` / `FEATURE_FLAG_EXISTS` / `FEATURE_FLAG_SYSTEM` / `FEATURE_FLAG_READ_ONLY` | 404 / 409 / 409 / 403 | Flag lookups, duplicates, system flag deletion, read-only flags |
| `EMAIL_TEMPLATE_NOT_FOUND` / `EMAIL_TEMPLATE_INVALID` / `EMAIL_TEMPLATE_VARIABLES_MISSING` | 404 / 400 / 400 | Template lookups, content validation, render without required variables |
| `ADMIN_SCOPE_DENIED` | 403 | A tenant-scoped admin reached global configuration |

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
