# Runbook: security alert triage

**Alerts:** `AnalivoAuthFailureSpike`, security event notifications (login failures, lockouts, MFA disablement, privilege changes, session replay detection, impersonation), reports from users or researchers.
**Rule:** treat it as real until shown otherwise, keep notes with timestamps from the start, and never paste tokens, passwords or customer data into chat or tickets.

## Triage (first 15 minutes)

1. **What kind of signal?**
   - Authentication failures by reason: `sum by (reason) (rate(analivo_auth_failures_total[5m]))`. `INVALID_CREDENTIALS` across many accounts from few IPs suggests credential stuffing; `SESSION_REVOKED` / replay codes suggest token theft.
   - Rate limiting: `analivo_api_errors_total{code="RATE_LIMITED"}` and `Rate limit exceeded` log lines with the limiter name.
   - Audit trail: admin portal, Audit logs, filtered by actor and time. Security events are written there.
2. **Scope:** one account, one tenant, or platform-wide? Which portal (tenant or admin)?
3. **Is it ongoing?** Watch the same queries for 5 minutes.

## Contain

| Situation | Action |
| --- | --- |
| Credential stuffing against tenant users | Limits are per IP and per account (`AUTH_RATE_LIMIT_*`). Lower them temporarily, or block the source at the edge (CDN/WAF). Affected accounts lock out automatically. |
| A compromised user or admin account | Suspend the account (admin portal). Suspension revokes its sessions within the status-cache window (`AUTH_STATUS_CACHE_TTL_MS`, 5 s). Reset the password and MFA together with the owner. |
| Leaked API key or embed token | Revoke it in the tenant's settings (or via support tooling). Requests with it fail at once. Tell the tenant to issue a new one. |
| Leaked webhook URL | Pause the connector (stops ingestion), then replace it with a new webhook connector (new URL and signing secret) and have the sender switch. There is no in-place token rotation yet. |
| Suspected platform secret leak (`JWT_SECRET`, `ENCRYPTION_KEY`, provider keys) | SEV1. Page the engineering lead. Rotation needs a planned procedure (all sessions end; encrypted connector secrets must be re-encrypted). |

Logs and error reports are scrubbed of bearer tokens, embed and webhook path tokens, `?token=` values, cookies and passwords. If you find a raw secret in any log or tracker, treat it as leaked: rotate it and file a bug against `src/utils/redact.js`.

## Investigate

- Follow the actor across requests with `requestId` / `traceId` (see [README.md](README.md#following-one-request)).
- Access logs (admin portal, Access logs) list authenticated requests per actor with masked paths.
- Preserve evidence: export the relevant audit and access logs before retention removes them.

## Close out

- Notify affected tenants as required by contract and law (legal decides on regulator notification).
- Write a short post-incident note: timeline, impact, root cause, follow-ups. Update this runbook if a step was missing.
