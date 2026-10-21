# PRODUCTION_DEPLOYMENT_RUNBOOK.md

**Audience:** Backend operator, DevOps engineer, on-call engineer.
**Purpose:** Step-by-step procedure to deploy the Analivo backend and frontend to production, configure the required environment, verify each gate, and roll back if a gate fails.

This runbook assumes the current deployment topology derived from the audited configuration:

- **Backend** hosted on Render (`https://saas-analytics-backend-ffao.onrender.com`).
- **Frontend** hosted on Vercel (`https://analivo.vercel.app`).
- **MongoDB** on MongoDB Atlas.
- **Redis** on Upstash (URL set in backend env).
- **Object storage** on AWS S3 (production) or local filesystem (dev/test).
- **Email** via SMTP (currently Gmail in `.env`; production should be a transactional provider).
- **Payments** via Razorpay (currently disabled by default).

If any of these change, update the relevant sections of this runbook and re-run the validation pass.

---

## 1. Required environment variables — deployment matrix

| Variable | Local development | Staging / test | Production / live | Where to configure |
|---|---|---|---|---|
| `NODE_ENV` | `development` | `staging` (or `production` with a staging deploy) | `production` | Backend hosting provider |
| `PORT` | `8080` | `8080` | `8080` | Backend hosting provider |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/saas_analytics` | Atlas cluster (staging) | Atlas cluster (production) | Backend hosting provider |
| `REDIS_URL` | (empty → in-memory) | Upstash Redis (test) | Upstash Redis (production) | Backend hosting provider |
| `JWT_SECRET` | dev-only default (rejected in prod) | strong random ≥32 chars | strong random ≥32 chars | Backend hosting provider |
| `ENCRYPTION_KEY` | (empty) | random ≥32 chars | random ≥32 chars | Backend hosting provider |
| `COOKIE_SECURE` | `false` | `true` (HTTPS) | `true` (HTTPS) | Backend hosting provider |
| `TRUST_PROXY` | `1` | `1` (behind Render) | `1` (behind Render) | Backend hosting provider |
| `STORAGE_PROVIDER` | `local` | `s3` (or `local` for staging) | `s3` | Backend hosting provider |
| `S3_BUCKET` | (empty) | staging bucket | production bucket | Backend hosting provider |
| `S3_REGION` | (empty) | staging region | production region | Backend hosting provider |
| `S3_ACCESS_KEY_ID` | (empty) | IAM key (staging) | IAM key (production, least-privilege) | Backend hosting provider |
| `S3_SECRET_ACCESS_KEY` | (empty) | IAM secret (staging) | IAM secret (production, least-privilege) | Backend hosting provider |
| `MAIL_PROVIDER` | `none` (test runner) or `smtp` | `smtp` | `smtp` | Backend hosting provider |
| `SMTP_HOST` | (empty) | staging SMTP host | production SMTP host (e.g. SendGrid, Mailgun) | Backend hosting provider |
| `SMTP_PORT` | (empty) | `587` | `587` | Backend hosting provider |
| `MAIL_USER` | (empty) | SMTP user | SMTP user | Backend hosting provider |
| `MAIL_PASSWORD` | (empty) | SMTP password | SMTP password | Backend hosting provider |
| `CLIENT_URL` | `http://localhost:3000` | staging frontend URL | `https://analivo.vercel.app` | Backend hosting provider |
| `CORS_ORIGINS` | `http://localhost:3000` | staging frontend URL | `https://analivo.vercel.app` | Backend hosting provider |
| `SOCKET_CORS_ORIGIN` | `http://localhost:3000` | staging frontend URL | `https://analivo.vercel.app` | Backend hosting provider |
| `RAZORPAY_ENABLED` | `false` | `true` (after test keys configured) | `true` (only after live test) | Backend hosting provider |
| `RAZORPAY_KEY_ID` | (empty) | test Key ID | live Key ID (only after authorised) | Backend hosting provider |
| `RAZORPAY_KEY_SECRET` | (empty) | test Key Secret | live Key Secret (only after authorised) | Backend hosting provider |
| `RAZORPAY_WEBHOOK_SECRET` | (empty) | test webhook secret | live webhook secret (only after authorised) | Backend hosting provider |
| `RAZORPAY_ENVIRONMENT` | `test` | `test` | `live` (only after authorised) | Backend hosting provider |
| `RAZORPAY_PLAN_MAPPING_JSON` | (empty) | populated with **placeholder** prices for staging | populated with **real** prices for live | Backend hosting provider |
| `JOB_BILLING_RECONCILE_ENABLED` | `false` | `false` initially; enable after test-cycle | `true` after live test passes | Backend hosting provider |
| `JOB_BILLING_RECONCILE_CRON` | `*/15 * * * *` | `*/15 * * * *` | `*/15 * * * *` | Backend hosting provider |
| `JOB_SHEET_SYNC_ENABLED` | `false` | `false` | `false` (not in scope) | Backend hosting provider |
| `JOB_EMAIL_ENABLED` | `true` | `true` | `true` (drains the email outbox: retries and dead letters) | Backend hosting provider |
| `JOB_CLEANUP_ENABLED` | `false` | `true` after a `npm run db:retention` dry run | `true` after a reviewed `npm run db:retention` dry run (section 5.4) | Backend hosting provider |
| `RETENTION_DRY_RUN` | `false` | `false` | `false` (`true` makes scheduled cleanup report only) | Backend hosting provider |
| `RETENTION_LEGAL_HOLD_TENANT_IDS` | (empty) | (empty) | tenant ids under legal hold, if any | Backend hosting provider |
| `JOB_ANOMALY_ENABLED` | `false` | `false` | `false` | Backend hosting provider |
| `LOG_LEVEL` | `debug` | `info` | `info` | Backend hosting provider |
| `LOG_REDACT` | defaults | defaults | defaults (includes `authorization`, `cookie`, `password`, `jwt`, `token`, `apiKey`) | Backend hosting provider |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | `10000` | `10000` | Backend hosting provider |
| `VITE_API_BASE_URL` | `http://localhost:8080` | staging backend URL | `https://saas-analytics-backend-ffao.onrender.com` | **Vercel** (frontend) |
| `VITE_API_PREFIX` | `/api/v1` | `/api/v1` | `/api/v1` | **Vercel** (frontend) |
| `VITE_RAZORPAY_KEY_ID` | (empty) | (empty) | (empty) | **Not required** — `keyId` flows from backend via checkout response |

### Cross-environment consistency rules

| Rule | Why |
|---|---|
| `VITE_API_PREFIX` (frontend) must equal the backend's effective `API_PREFIX` | Otherwise the frontend calls non-existent routes. |
| `VITE_API_BASE_URL` (frontend) must equal the public URL where the backend is reachable from the browser | Otherwise CORS preflights and Socket.IO handshakes fail. |
| `CORS_ORIGINS` / `SOCKET_CORS_ORIGIN` (backend) must include `VITE_API_BASE_URL`'s origin | Otherwise the browser blocks the frontend's cross-origin requests. |
| `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` must come from the same Razorpay environment (test or live) | Mixing them causes signature verification failures. |
| `RAZORPAY_WEBHOOK_SECRET` (backend) must match the secret configured on the corresponding Razorpay Dashboard webhook | Otherwise every webhook returns 401. |
| `RAZORPAY_ENVIRONMENT` must be consistent with the Key ID prefix (`rzp_test_` or `rzp_live_`) | Inconsistency is a configuration error; the application does not auto-switch. |

### Which values belong where

| Value category | Belongs in | Never in |
|---|---|---|
| `JWT_SECRET` | Backend env | Frontend env, logs, code comments |
| `ENCRYPTION_KEY` | Backend env | Frontend env, logs, code comments |
| `RAZORPAY_KEY_SECRET` | Backend env | Frontend env, logs, code comments |
| `RAZORPAY_WEBHOOK_SECRET` | Backend env | Frontend env, logs, code comments |
| `MONGODB_URI` (with credentials) | Backend env | Frontend env, logs |
| `S3_SECRET_ACCESS_KEY` | Backend env | Frontend env, logs |
| `MAIL_PASSWORD` | Backend env | Frontend env, logs |
| `REDIS_URL` (with credentials) | Backend env | Frontend env, logs |
| `VITE_API_BASE_URL` | Frontend env (Vercel) | Backend env |
| `VITE_API_PREFIX` | Frontend env (Vercel) | Backend env |
| `CLIENT_URL` | Backend env | Frontend env |
| `CORS_ORIGINS` | Backend env | Frontend env |

### Which changes require a redeploy or restart

| Change | Restart required? | Notes |
|---|---|---|
| Any backend env var (except those read lazily) | **Yes** — redeploy the backend | Render redeploy picks up all env changes. |
| `VITE_*` env var | **Yes** — redeploy the frontend | Vite bakes env vars at build time. |
| Razorpay Dashboard webhook secret | **Yes** — update `RAZORPAY_WEBHOOK_SECRET` in backend env and redeploy | The two values must match exactly. |
| Razorpay Dashboard webhook URL | No (it's just a dashboard setting) | But the backend must be reachable at that URL. |
| Razorpay Dashboard active events | No | Backed by the implementation's allowlist. |

---

## 2. Pre-deploy checklist

- [ ] MongoDB cluster is provisioned and reachable from the backend hosting provider.
- [ ] Redis is provisioned and reachable.
- [ ] Object storage (S3 bucket) is provisioned and reachable.
- [ ] SMTP credentials are obtained.
- [ ] All backend env vars from §1 are prepared (secrets in a password manager).
- [ ] `RAZORPAY_PLAN_MAPPING_JSON` is set with real prices (not placeholders) before live activation.
- [ ] Frontend `VITE_API_BASE_URL` points to the deployed backend.
- [ ] Frontend `VITE_API_PREFIX` matches the backend.
- [ ] CORS / SOCKET_CORS_ORIGIN allowlists include the frontend origin.
- [ ] CI guards pass locally (`node scripts/ci/run-all.js`).
- [ ] Full backend test suite passes locally (`node scripts/ci/run-tests.js`).
- [ ] Frontend tests pass locally (`npm test`).
- [ ] Frontend builds without errors (`npm run build`).

---

## 3. Deploy procedure

### 3.1 Deploy the backend

1. Push the working tree to the deployment branch (the operator authorises this separately).
2. Trigger a Render deploy (or equivalent on the chosen platform).
3. Monitor the deploy log:
   - The production-config validator must not throw. If it throws, the deploy will fail to start. Check the error message; the validator reports which env vars are invalid.
   - The app must log `Listening on port …` (or equivalent) within the platform's expected startup window.
4. Hit the health endpoints:
   - `GET /api/v1/health` → 200 with `data.status: "ok"`.
   - `GET /api/v1/health/ready` → 200 (or 503 if MongoDB is not yet connected; retry once).
5. Confirm the app is reachable from the public internet at the configured URL.

### 3.2 Deploy the frontend

1. Push the working tree to the deployment branch.
2. Vercel auto-builds. Confirm the build succeeds (no TypeScript errors, no Vite errors).
3. Hit the deployed frontend in a browser. Confirm:
   - The page loads.
   - Network requests to the backend succeed (no CORS errors in the console).
   - Login works end-to-end.

### 3.3 Configure the Razorpay webhook

See `RAZORPAY_CONFIGURATION_GUIDE.md` §5.2. This requires operator action in the Razorpay Dashboard. Do **not** attempt to automate it.

### 3.4 Verify each gate

For each row in §1, confirm the value is set in the production environment, that the value is not a placeholder, and that the application is using it.

| Gate | Verification command | Expected result |
|---|---|---|
| MongoDB connectivity | `GET /api/v1/health/ready` | 200 with `data.checks.database: "ok"` |
| Redis connectivity | App startup logs | No "Redis cache connection error" warnings |
| CORS allowlist | Browser console on the frontend | No CORS errors |
| Helmet / security headers | `curl -I <BACKEND_URL>/api/v1/health` | `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Content-Security-Policy` headers present; `Strict-Transport-Security` present in production |
| JWT secret | App startup | No "Invalid production configuration" error |
| Razorpay | `POST /api/v1/tenants/:id/subscription/checkout` (as workspace Owner) | If enabled: returns a checkout session; if disabled: returns 501 |

---

## 4. Rollback guidance

### 4.1 When to roll back

| Symptom | Roll back? | How |
|---|---|---|
| Production-config validator throws at startup | Yes | Revert the most recent env var change. The validator's error message identifies the offending var. |
| `GET /api/v1/health/ready` returns 503 for >5 minutes after deploy | Yes | Revert the deploy (Render: "Rollback to previous deploy"). |
| CORS errors flood the frontend after a deploy | Yes | The most likely cause is a CORS_ORIGINS / SOCKET_CORS_ORIGIN change. Revert or correct. |
| A specific feature is broken (e.g. checkout) | Depends | If the breakage is in the most recent commit, revert. If it's a configuration issue, fix the env var without a rollback. |
| Razorpay live-mode activation goes wrong | Yes | Set `RAZORPAY_ENABLED=false` and redeploy. The platform returns 501 honestly until the operator investigates. |

### 4.2 How to roll back

| Platform | Action |
|---|---|
| Render (backend) | Render Dashboard → Service → "Rollback" to the previous deploy. No env change needed. |
| Vercel (frontend) | Vercel Dashboard → Project → Deployments → click a previous successful deployment → "Promote to Production". |
| MongoDB | Do **not** roll back the database for a code-only issue. Data migrations are out of scope for this runbook. |
| Redis | Do **not** roll back Redis for a code-only issue. |
| Razorpay | Disable the webhook on the Dashboard to stop incoming traffic. Disable `RAZORPAY_ENABLED` in the backend env. |

### 4.3 What NOT to do during a rollback

- Do **not** delete production data.
- Do **not** change MongoDB schemas without a migration.
- Do **not** rotate secrets as part of a rollback unless the secret itself is the cause of the incident.
- Do **not** enable `RAZORPAY_ENVIRONMENT=live` as part of a rollback.

---

## 5. Health and observability

### 5.1 Endpoints

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /api/v1/health` | Liveness — process is running | Public |
| `GET /api/v1/health/ready` | Readiness — 503 when MongoDB, Redis or the job queue is down; 200 `degraded` when storage, SMTP or the scheduler heartbeat fails. Use as the Render health check path. | Public |
| `GET /api/v1/status` | Public status summary (component states only) | Public |
| `GET /api/v1/metrics` | Prometheus metrics | Bearer `METRICS_TOKEN` (404 when unset) |
| `GET /api/v1/billing/webhook/health` | Webhook liveness — provider status | Public |
| `GET /api/v1/admin/...` | Admin operations | Admin auth + permission |

### 5.2 Logs

The application uses Pino. In production, `LOG_LEVEL=info` and `LOG_REDACT` masks `authorization`, `cookie`, `password`, `jwt`, `token`, `apiKey`. Sensitive values should never appear in logs.

To find a specific request, grep by `requestId` (every request gets a UUID).

### 5.3 Audit log

All sensitive actions (subscription change, plan change, webhook receipt, reconciliation, admin actions) are persisted in the `AuditLog` collection. `RETENTION_AUDIT_LOG_DAYS` (default 90) is enforced by the cleanup job only once `JOB_CLEANUP_ENABLED=true` (section 5.4). Until then nothing is purged and no retention period can be claimed.

### 5.4 Retention (cleanup job)

The cleanup job (`src/jobs/cleanup.job.js`, policies in `src/services/retention.service.js`) enforces every `RETENTION_*` window per collection: audit trail (oldest rows first, never in the middle), access logs, login attempts, revoked sessions, used tokens and invitations, notifications, alert history, analytics query records, job and sync runs, outbox emails, export files (deleted at `expiresAt`, after which status polls answer 410) and export rows, report files, soft-deleted rows, soft-deleted users (anonymised, then deleted) and, when `RETENTION_ARCHIVED_TENANT_DAYS` is set, archived tenants. Each run records its per-collection counts on the job run (`GET /monitoring/jobs/runs?job=cleanup`) and one `governance` audit event; `GET /monitoring/retention` lists the effective windows.

Enabling it in an environment:

1. Run `npm run db:retention` (dry run; it connects with `MONGODB_URI`) and review the per-policy counts.
2. Put any tenant under legal hold in `RETENTION_LEGAL_HOLD_TENANT_IDS` (or set `legalHold: true` on its Tenant row).
3. Either run `npm run db:retention -- --apply` once, or set `JOB_CLEANUP_ENABLED=true` and let the 03:00 run do it. Large first purges are bounded (`RETENTION_BATCH_SIZE` x `RETENTION_MAX_BATCHES_PER_RUN` rows per policy per run) and continue on later runs.
4. For S3, a bucket lifecycle rule on `storage/audit/exports/` and `storage/access-logs/exports/` (for example 7 days) is a useful backstop; the job deletes the objects itself.

### 5.5 Email outbox

Transactional email is recorded in the `OutboundEmail` collection and sent by the email job (`JOB_EMAIL_ENABLED=true`, every minute) with exponential backoff (`OUTBOX_*`); after `OUTBOX_MAX_ATTEMPTS` a message is dead-lettered. `GET /monitoring/health/mail` reports the transport, backlog and dead letters; `GET /monitoring/outbox?status=dead` lists them and `POST /monitoring/outbox/:id/requeue` (`monitoring.update`) retries one. SMTP connections use bounded timeouts (`SMTP_CONNECTION_TIMEOUT_MS`, `SMTP_GREETING_TIMEOUT_MS`, `SMTP_SOCKET_TIMEOUT_MS`).

---

## 6. Deferred operational work

The following items are **explicitly out of scope** for this audit and should be tracked in a follow-up sprint:

| Item | Why deferred | Suggested follow-up |
|---|---|---|
| MongoDB automated backups | Task rules exclude backup infrastructure | Provision Atlas continuous backup + point-in-time recovery; test restore quarterly. |
| Email delivery monitoring | Task rules defer this | Add SendGrid / Mailgun bounce + open tracking; alert on bounce rate > 5%. |
| Refresh token rotation | Not raised in this audit | Rotate refresh token on each use; revoke old token. |
| Impersonation token rotation | Not raised in this audit | Invalidate impersonation token on admin logout. |

---

## 7. Known limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| Single-flight in `reconcilePending` is per-process, not distributed | In a multi-instance deployment, all instances may run the cron at the same time. The `transitionStatus` conditional update prevents double-capture, but the work is duplicated. | Deploy with a single backend instance, or disable the cron and use the manual admin endpoint. |
| `VITE_RAZORPAY_KEY_ID` is unused | None — the `keyId` flows from the backend. | Leave empty. |
| Only `INR` currency is supported | Plans with non-INR pricing are rejected. | This is a deliberate product decision (Indian market only). Multi-currency support requires a separate effort. |
| One-time orders only | Customers must manually renew. | Recurring billing is a future-effort item. |

---

## 8. On-call runbook (short form)

1. **App down?** Check Render status, then Render logs, then check `GET /api/v1/health/ready`.
2. **CORS errors?** Check `CORS_ORIGINS` and `SOCKET_CORS_ORIGIN` in the backend env.
3. **Webhook failing?** Check Razorpay Dashboard → Webhooks → Logs for the most recent delivery; check `RAZORPAY_WEBHOOK_SECRET` in the backend env.
4. **Checkout 501?** Check `RAZORPAY_ENABLED` and `RAZORPAY_KEY_SECRET`.
5. **Checkout 422 "no configured pricing"?** Check `RAZORPAY_PLAN_MAPPING_JSON`.
6. **Reconciliation not firing?** Check `JOB_BILLING_RECONCILE_ENABLED` and `SCHEDULER_ENABLED`.
7. **MongoDB slow?** Check Atlas metrics; check `MONGODB_MAX_POOL_SIZE`.
8. **Redis warnings?** Check `REDIS_URL` and the provider. The app does NOT fall back to in-memory at runtime: readiness turns 503 and enqueueing fails fast with 503 until Redis is back. See `src/docs/development/runbooks/redis-down.md` (all runbooks: `src/docs/development/runbooks/`).
