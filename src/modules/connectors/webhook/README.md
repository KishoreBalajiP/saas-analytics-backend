# Connector: Webhook

Planned scope - NOT implemented in Phase 1.1.

Future responsibilities (implemented as a `BaseConnector` subclass):

- Receive inbound HTTP events from provider webhooks (and streaming sources)
- Verify provider signatures before trusting any payload
- Normalise events into the platform's record shape
- Buffer high-frequency events into `src/queues/connector.queue.js` for
  batched ingestion rather than handling them inline

Hook points already prepared:
- `src/routes/webhook.routes.js` - reserved inbound webhook surface
- `src/middleware/error.middleware.js` - will map provider auth failures to
  consistent errors
- `utils/encryption.js` - will store per-provider signing secrets

Security notes
- Never process an unverified webhook (signature check is mandatory).
- Inbound webhooks often need a raw body parser (`express.raw`) - plan for
  that when the router is implemented.
