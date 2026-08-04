# Platform / notifications

Notifications are **messages delivered to a user** through one or more
channels: in-app, email, push, webhook. The notification module decides
*what* and *to whom*; the channels decide *how*.

## Why it exists

Without a unified layer, every module hand-rolls in-app / email / push
triggers. With one, behaviour is consistent, opt-outs are respected, and
delivery is measurable.

## Data shape (architecture only)

`models/Notification.js`:

```
_id, tenantId, actorId (recipient), actorType: 'user'|'admin',
channel: 'in_app' | 'email' | 'push' | 'webhook',
templateKey,                              // ref: notificationTemplates.key
data (json),                              // template variables
priority: 'low' | 'normal' | 'high',
status: 'queued' | 'delivered' | 'failed' | 'read',
readAt?, deliveredAt?, failedReason?,
groupKey?,                                // for collapsing many into one
createdAt
```

## Planned endpoints (`/api/v1/notifications`)

- `GET    /`                           - inbox for the current user
- `GET    /unread-count`               - cheap badge value
- `POST   /:id/read`                   - mark read
- `POST   /read-all`                   - mark all read
- `DELETE /:id`                        - delete (soft) from inbox
- `POST   /admin/broadcast`            - admin-only cross-tenant broadcast (Phase 4+)
- `GET    /admin/preferences/:userId`  - user notification preferences

## Architectural shape

- Service: `src/services/notification.service.js` - the dispatcher. It
  picks template, applies user preferences, hands off to the channel.
- Workers consume from `src/queues/` per channel (planned: `email.queue`
  for emails).
- Templates: `src/platform/notifications/templates/` JSON-form, server
  variables server-side, no business logic.

## Coding guidelines

- Never send to users without a registered preference except for
  transactional/auth notifications (MFA, password reset).
- Channel choice respects tenant `settings/` + `feature-flags/`.
- WebSocket emit on every `in_app` notification (room `user:<id>`).
- All sends audited; failed sends retried with backoff (max 3).

## Future extension

- Per-tenant digest ("daily roll-up" job via scheduler).
- Quiet hours / Do Not Disturb per user.
- Push via APNs / FCM in the mobile app.
