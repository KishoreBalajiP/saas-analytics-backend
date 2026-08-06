# Backend — WebSockets (Socket.IO)

> **WHAT this is:** the deep-dive on the Socket.IO room model and the
> realtime surface.
> **WHY it exists:** dashboards, notifications and embed widgets
> need realtime updates without polling.
> **HOW to use it:** read *Architecture* before emitting; respect the
> room naming convention.
> **WHEN to update it:** as the realtime surface evolves.
> **WHERE it lives:** `src/docs/backend/websockets.md`.

---

## Purpose

> **WHAT this is:** the deep-dive on WebSockets.
> **WHY it exists:** dashboards, notifications and embed widgets need
> realtime updates.
> **HOW to use it:** read *Architecture* before emitting.
> **WHEN to update it:** as the surface evolves.
> **WHERE it lives:** `src/docs/backend/websockets.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 5 / 9 implementer** | Has the room model. |
| **Frontend engineer** | Has the contract. |

## Current Status

> **Status:** `Implemented` — Socket.IO bootstrap in Phase 1;
> room helpers in Sprint 0; consumers land in Sprints 5, 9.
> **Sprint:** Sprint 0 (bootstrap); Sprints 5, 9 (consumers).
> **Owner:** Engineering team.

## Business Perspective

Dashboards reflect data changes in realtime. In-app notifications
arrive without polling. Embed widgets stay in sync with their
source. All three use the same Socket.IO room model.

## Technical Perspective

Socket.IO 4 with the Redis adapter (when `REDIS_URL` is set) for
cross-instance broadcasts. Room naming follows the canonical
prefixes in `config/constants.js#SOCKET.ROOMS`.

## Room Conventions

| Room | Built by | Listeners |
| --- | --- | --- |
| `app:all` | — | every connected client (admin broadcast) |
| `tenant:<id>` | `authenticate` (Sprint 1) | every session in this tenant |
| `dashboard:<id>` | `dashboard.service.js` (Sprint 9) | every viewer of this dashboard |
| `user:<id>` | `notifications.service.js` (Sprint 5) | the user (in-app notifications) |
| `embed:<tokenHash>` | `embed.service.js` (Sprint 9) | every viewer of this embed |

## Event Conventions

| Event | Emitted by | Payload |
| --- | --- | --- |
| `app:connected` | `connect` handler | `{ socketId, ts }` |
| `app:ping` | client | `{ ts }` |
| `app:error` | server | `{ message, code }` |
| `dashboard:updated` | `dashboard.service.js` | `{ dashboardId, version }` |
| `embed:updated` | `embed.service.js` | `{ embedToken, dashboardId }` |
| `notification:created` | `notifications.service.js` | `{ id, type, payload }` |

## Real-world Examples

### Join a tenant room

```js
import { getIO } from '../websocket/index.js';

io.to(`tenant:${tenantId}`).emit('notification:created', {
  id: 'ntf_01H...',
  type: 'connector.sync.failed',
  payload: { connectorId: 'con_01H...' },
});
```

### Dashboard update

```js
io.to(`dashboard:${dashboardId}`).emit('dashboard:updated', {
  dashboardId,
  version: newVersion,
});
```

### In-app notification

```js
io.to(`user:${userId}`).emit('notification:created', {
  id: notification.id,
  type: notification.type,
  payload: notification.payload,
});
```

## Best Practices

| Do | Why |
| --- | --- |
| **Use the canonical room names.** | Rooms must agree across instances. |
| **Emit from the service layer**, not the controller. | Controllers return HTTP; services emit events. |
| **Use the Redis adapter** when multi-instance. | Without it, only the local instance sees the emit. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Polling as a substitute for Socket.IO.** | Defeats the realtime contract. |
| **Cross-tenant emit.** | The `tenant:<id>` room is per-tenant; never broadcast tenant data to `app:all`. |

## Future Work

| Item | Phase |
| --- | --- |
| **Multi-instance cross-region broadcast** | Phase 4 |

---

## Summary

Socket.IO 4 with a canonical room model. Sprints 5 and 9 emit on
the right rooms; the frontend subscribes on the right rooms.

## Key Takeaways

- **Canonical room names.**
- **Redis adapter for multi-instance.**
- **Emit from the service layer.**

## Related Documents

- [`../../websocket/`](../../../src/websocket/) — Socket.IO bootstrap
- [`../../config/constants.js`](../../../src/config/constants.js) — `SOCKET.ROOMS`

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)