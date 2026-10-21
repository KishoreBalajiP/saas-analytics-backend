# Connector: Webhook

Inbound provider events: `POST /api/v1/webhooks/:webhookToken` (public,
authenticated by an HMAC signature, never by a JWT).

## Signing contract (signature version 2, every new connector)

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Saas-Timestamp` | Unix time in **seconds** when the request is sent |
| `X-Saas-Signature` | `v2=` + hex `HMAC_SHA256(signingSecret, "<timestamp>.<raw body>")` |

- The signed payload is the timestamp, a literal `.`, then the exact body bytes.
- The timestamp must be within the connector's tolerance (default 300 s,
  configurable per connector up to 3600 s; at most 60 s in the future).
- A delivery is accepted once: the same signature inside the window is
  refused with `409 WEBHOOK_REPLAYED`. Sign every delivery (and every retry)
  with a fresh timestamp.

Example (Node):

```js
const ts = Math.floor(Date.now() / 1000);
const body = JSON.stringify({ events: [{ id: 'evt_1', amount: 1200 }] });
const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
await fetch(url, { method: 'POST', body, headers: {
  'content-type': 'application/json', 'x-saas-timestamp': String(ts), 'x-saas-signature': `v2=${sig}` } });
```

## Legacy connectors (signature version 1)

Connectors created before v2 have no `webhookSignatureVersion` and still
accept `X-Saas-Signature: sha256=<hex HMAC of the body>` while
`WEBHOOK_LEGACY_SIGNATURES_ENABLED=true`; such responses carry
`Deprecation: true`. They also accept `v2=` signatures, so a sender can move
first; then `PATCH /connectors/:id { "webhookSignatureVersion": 2 }`
(one-way) makes v2 mandatory.

## Request pipeline (cheap checks first)

1. token shape -> 401 (opaque)
2. JSON content type -> 415 `WEBHOOK_UNSUPPORTED_MEDIA_TYPE`
3. body size (`WEBHOOK_MAX_BODY_KB`, enforced while the body is read) -> 413 `WEBHOOK_PAYLOAD_TOO_LARGE`
4. connector lookup by token -> 401 (opaque)
5. paused connector -> 409 `CONNECTOR_PAUSED`
6. tenant not active -> 403 `TENANT_NOT_ACTIVE`
7. signature / timestamp header format and window -> 401 `WEBHOOK_*`
   (a legacy connector whose window lives only in its encrypted config is
   pre-checked against the 3600 s outer bound and checked exactly after step 8)
8. signing key: decrypted once per connector and cached
   (`WEBHOOK_KEY_CACHE_TTL_SECONDS`, `webhook.keyCache.js`)
9. constant-time HMAC verify -> 401 `WEBHOOK_SIGNATURE_INVALID`
10. replay claim (`webhook.replay.js`, Redis `SET NX EX`) -> 409
11. records cap (`WEBHOOK_MAX_RECORDS`) -> 413 `WEBHOOK_TOO_MANY_RECORDS`
12. storedRows quota (reserved per record; the worker gives back rows that
    only updated existing ones) -> 409 `QUOTA_EXCEEDED`
13. ingest job enqueued -> 202

Steps 1-7 never touch the signing key, so forged or stale requests cannot
force the scrypt key derivation.

## Files

- `webhook.body.js` - bounded raw-body parser (typed 413 while the body is read)
- `webhook.verify.js` - signing contract, pre-checks, verification
- `webhook.keyCache.js` - per-connector decrypted-key cache
- `webhook.replay.js` - replay store
- `webhook.connector.js` - payload normalisation (array, `events`, `data`, single object)
