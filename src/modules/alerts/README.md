# Module: Alerts

Planned scope - NOT implemented in Phase 1.

- Anomaly detection (job stub: `src/jobs/anomaly.job.js`)
- Notifications (email via `src/jobs/email.job.js`, plus Socket.IO push)
- Outbound webhooks
- Inbound provider webhooks (signature-verified; see `webhook.routes.js`)

Hook points already prepared:
- `src/routes/webhook.routes.js` - empty router for inbound webhooks
- `src/jobs/anomaly.job.js` / `email.job.js` - scheduled entry points
- `config/constants.js` -> `SOCKET.EVENTS.NOTIFICATION`
