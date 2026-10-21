# Module — Status

**Sprint:** 4 — Connector Platform
**Status:** 🕏 In Progress

**Implements:** the `webhook` connector — inbound
`POST /api/v1/webhooks/:webhookToken` with `express.raw` (signature-safe),
HMAC-SHA256 verification of `X-Saas-Signature` against the decrypted
`signingSecret`, constant-time compare, and enqueue into the connector queue.
Phase 1 (roadmap 1.8): timestamp-bound `v2` signatures over
`${timestamp}.${body}`, mandatory timestamp window, replay store, secret-free
pre-checks before the (cached) key derivation, legacy transition - see
`README.md`.

**Real source files (in progress):**

- `src/modules/connectors/webhook/webhook.connector.js`
