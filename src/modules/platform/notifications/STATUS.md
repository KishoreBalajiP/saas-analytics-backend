# Module — Status

**Sprint:** 7 (Reports, Alerts, Notifications & Scheduling)
**Status:** ✅ Implemented (Sprint 7 close)
**Implements:** the user-facing notification inbox + preferences. Alert
triggers and other events dispatch into this surface (in-app + email channel
stub). Tenant- and actor-scoped; never leaks across tenants.
**Real source files:**
- `src/models/Notification.js`
- `src/services/notification.service.js`
- `src/repositories/notification.repository.js`
- `src/controllers/notification.controller.js`, `src/routes/notification.routes.js`
- dispatch entry point used by `alert.service.js` →
  `notification.repository.create` / `notification.service`.

## What works (verified by integration tests)

- Inbox list (`GET /notifications`), unread count, mark-read (single +
  all), soft-delete, preferences read/write.
- Tenant + actor scoping: a notification is only visible to its recipient;
  cross-tenant access is denied (404/empty).
- RBAC: `notifications.view` required; 401 without a token, 403 without
  permission.
- Alert evaluation dispatches an in-app notification to the alert owner +
  any configured recipients on trigger.

## Notes

- The email channel is dispatched through `email.service` (SMTP/noop
  transport) — the outbound email *consumer* is a later-sprint deliverable,
  so email delivery is best-effort in this sprint. The in-app channel is
  fully functional and is what the integration tests assert on.

## Test coverage

`tests/notifications/notification.routes.integration.test.js` — inbox
lifecycle (list, unread-count, mark-read, delete, preferences), RBAC
401/403.

**Last updated:** Sprint 7 close — 2026-08-12.
