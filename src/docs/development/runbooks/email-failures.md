# Runbook: email failures

**Alerts:** `AnalivoEmailFailures`, `AnalivoDependencyDown{dependency="smtp"}`, readiness `degraded` with `"smtp":"down"`.
**Impact:** verification, invitation, password-reset, report and alert emails are not delivered. Users cannot finish sign-up or reset passwords. SEV2.

## Confirm

1. `/api/v1/health/ready` shows `"smtp":"down"` (SMTP is non-critical: the API keeps serving, readiness is `degraded`). The check runs `transport.verify()` at most every `READINESS_SMTP_TTL_MS`.
2. Admin Monitoring, or `GET /monitoring/health/smtp`, gives a short error (connection refused, timeout, authentication failed).
3. Logs: `dependency smtp is down` (logged once when it goes down) and `email send failed` per message, each with `requestId`/`traceId` of the action that sent it.
4. Metrics: `analivo_email_sends_total{outcome="failed"}` rising, `outcome="sent"` flat. `analivo_outbox_backlog` shows mail waiting to be delivered.
5. Check the provider dashboard (bounces, suspensions, sending limits).

## Act

1. **Authentication failed:** the SMTP password or API key was rotated or revoked. Update `MAIL_USER` / `MAIL_PASSWORD` and redeploy web and worker.
2. **Timeouts:** the provider is slow or unreachable. Sends give up after `SMTP_CONNECTION_TIMEOUT_MS` / `SMTP_SOCKET_TIMEOUT_MS` instead of blocking requests for minutes. Check the provider status; consider switching to a backup provider by changing `SMTP_HOST` and credentials.
3. **Account suspended or over quota:** contact the provider. Do not create a new account to get around a suspension without reviewing why (often a bounce or spam complaint spike).
4. **Sender rejected:** check `MAIL_FROM` against the provider's verified domains (SPF, DKIM, DMARC).

## Verify recovery

- `GET /monitoring/health/smtp` returns `ok`; logs show `dependency smtp recovered`.
- `analivo_email_sends_total{outcome="sent"}` rises again and the backlog drains.
- Users who did not get verification or reset emails during the outage can use "resend" (verification) or request a new reset link.

## Escalate

Provider outage over 1 hour, or a suspension: page the engineering lead; product decides whether to post on the status page (`email_delivery` component).
