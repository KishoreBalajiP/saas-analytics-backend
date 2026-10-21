# 14. Security assessment

**Audience:** the security owner and the engineers who will remediate. Each item below is a source-backed finding; none was exploited against a live system. Reproduction conditions use a local or staging deployment with synthetic tenants only.

**Overall assessment.** The core tenant data paths (connectors, dashboards, analytics, reports, alerts) scope correctly by the tenant in the signed access token, and the authentication core is sound (separate audiences, live session checks, refresh rotation with family revocation, hashed secrets, encrypted credentials, strict production configuration gates). The serious problems sit at the edges: management routes that forget tenant context, privilege boundaries inside both the tenant and platform planes, a connector that can reach internal networks, unvalidated aggregation expressions, and controls (indexes, retention, rate-limit stores) that exist in code but are not effective in production. **Registration is self-service, so "a tenant Owner" means "anyone on the internet".**

Severities are provisional until merged with the adversarial verification results; the register (document 19) carries the final verdict and severity for each.

## 1. Critical and high findings

### 1.1 Cross-tenant read, modify and revoke of API keys and embed tokens ({{TEN:apikey-idor}})

| | |
|---|---|
| Severity | **High** (critical if any key or embed token exists in production). Latent today because creation is broken by the same defect |
| Boundary | Tenant isolation |
| Root cause | `/api-keys` and `/embed/tokens` routers never run `resolveTenant`; controllers pass `req.tenant` (undefined); `apiKey.repository.findById` adds `tenantId` only when truthy (`backend/src/repositories/apiKey.repository.js:43-44`); embed repository likewise |
| Reproduction (local) | Create tenants A and B by registration. Insert one `ApiKey` for B directly in the test database. As A's owner, call `GET /api/v1/api-keys/<B key id>`, `PATCH` it, then `POST /api/v1/api-keys/<id>/revoke` |
| Impact | Read key metadata and scopes of any tenant, extend expiry or widen scopes, revoke other tenants' integrations; same for embed tokens |
| Remediation | Mount `resolveTenant` and pass `req.tenant.id`; make every tenant-scoped repository **throw** when `tenantId` is missing; add a lint/guard that tenant-data routes include tenant resolution |
| Regression test | Cross-tenant get/update/revoke returns 404 for keys and embed tokens; repository unit test that a missing `tenantId` throws |
| Production check | Count `ApiKey` and `EmbedToken` documents in production (read-only query by an operator) |

### 1.2 Paid plan without payment ({{BIL:free-upgrade}})

| | |
|---|---|
| Severity | **High** (critical once `iam.subscriptions.update` is seeded, which is the obvious fix for billing 403s) |
| Boundary | Monetisation / authorisation |
| Root cause | `subscription.service.changePlan` writes any `planId` directly; `reactivate` lifts admin restriction; both exposed on the workspace router |
| Reproduction | Grant a test Owner `iam.subscriptions.update`; `POST /api/v1/tenants/<id>/subscription/change-plan {"planId": "<enterprise>"}` |
| Remediation | Remove direct plan writes from workspace routes; upgrades only via confirmed payment; admin overrides on admin routes with audit |
| Regression test | Workspace change-plan to a paid plan without payment → 403/409; reactivate of an admin-restricted subscription → 403 |
| Production check | Whether billing permissions were hand-seeded |

### 1.3 Admin list returns password hashes and MFA secrets ({{ADM:pwhash}})

| | |
|---|---|
| Severity | **High** |
| Boundary | Platform admin credentials |
| Root cause | `admin.repository.list` returns lean documents; no projection; no `toJSON` transform (`backend/src/repositories/admin.repository.js:87-101`) |
| Reproduction | As any admin with `iam.admins.view`, `GET /api/v1/admin/admins` and inspect `passwordHash`, `mfaSecret` |
| Impact | Offline cracking of admin password hashes (Argon2id slows but does not prevent it); encrypted TOTP secrets exposed to anyone who later obtains `ENCRYPTION_KEY` |
| Remediation | Projection excluding secrets in every admin read; `select: false` on secret fields; response serializer allow-list |
| Regression test | List and detail responses never contain `passwordHash`, `mfaSecret`, `failedAttempts`, `lockedUntil` |

### 1.4 Platform admin self-escalation ({{ADM:self-escalate}}, {{ADM:self-patch}})

| | |
|---|---|
| Severity | **High** |
| Root cause | `assignRole` has no self-target or ceiling check; `PATCH /admin/admins/:id` accepts `adminType` and `tenantScope` for one's own account |
| Reproduction | Support admin with `iam.admins.assign` assigns the `super` role to themselves; or PATCHes own `tenantScope` to null |
| Remediation | Forbid self-targeted privilege changes; role ceiling; two-person approval for super; step-up authentication |
| Regression test | Self-assign and self-patch of privilege fields → 403 |

### 1.5 MFA disabled by re-enrolment ({{AUTH:mfa-reenroll}})

| | |
|---|---|
| Severity | **High** |
| Root cause | `mfa.service.enroll` overwrites the secret with `mfaEnabled: false` for any authenticated admin; no step-up; the explicit disable route is not mounted |
| Reproduction | With an MFA-enabled admin's access token, `POST /api/v1/admin-auth/mfa/enroll`; next login succeeds with password only |
| Impact | A stolen 15-minute access token permanently downgrades an admin account to password-only |
| Remediation | Refuse enrol when enabled; disable and reset require password + current code (or recovery code); audit and alert |
| Regression test | Second enrol on an enabled account → 409; login still demands TOTP |

### 1.6 Tenant Admin can create Owners ({{TEN:invite-owner}}) and revoked invitees can still get in ({{TEN:invite-revoke}})

| | |
|---|---|
| Severity | **High** |
| Root cause | Invitation `roleName` is free text with no ceiling; invitation provisioning creates the user and role grant immediately; login accepts status `invited`; password reset works for invited users; revoke only flips the invitation row |
| Reproduction | As tenant Admin, invite `x@example.test` with `roleName: "Owner"`. Separately: invite, revoke, then use "forgot password" for the invitee's email and log in |
| Remediation | Role id with ceiling; provision the user only on acceptance (or keep status `invited` non-loginable); refuse reset for non-active accounts; revoke removes provisional grants |
| Regression tests | Admin → Owner invite refused; invite → revoke → forgot → reset → login fails |

### 1.7 SSRF through the MongoDB connector ({{CON:ssrf}})

| | |
|---|---|
| Severity | **High** (impact depends on Render egress and what listens on internal networks) |
| Root cause | Validator checks only the URI scheme (`backend/src/modules/connectors/shared/validators.js:74-92`); any host, port and driver option (including authentication mechanisms that fetch cloud credentials) is accepted; driver error strings are returned to the tenant |
| Reproduction (local only) | Create a MongoDB connector pointing at `mongodb://127.0.0.1:<port>/x` or a link-local address in a local network you control; observe timing and error differences |
| Impact | Internal port scanning and service probing from the platform's network; possible abuse of driver auth options |
| Remediation | Resolve hostnames and deny private, loopback, link-local and metadata ranges at connect time (re-check after resolution); allow-list URI options; require TLS; generic errors |
| Regression test | Connector creation with private or metadata targets and forbidden options → 422 |

### 1.8 Aggregation-expression injection and unbounded queries ({{ANA:expr}})

| | |
|---|---|
| Severity | **High** (DoS; code execution inside the database only if server-side JavaScript is enabled) |
| Root cause | Filter `value` placed verbatim inside `$expr`; field names unvalidated; no `maxTimeMS`; same path through widgets, reports, alerts and the external API |
| Reproduction (local) | `GET /api/v1/analytics?filters=[{"field":"a","op":"eq","value":{"$range":[0,100000000]}}]` against a test tenant and observe CPU/memory |
| Tenant isolation | Not broken: the leading `$match` restricts to the caller's tenant |
| Remediation | Strict query schema (scalars only for values, safe field-name pattern); `maxTimeMS`; per-tenant concurrency limits; disable server-side JavaScript on the cluster if possible |
| Regression test | Object or array-of-object values and `$`-prefixed fields → 400 |

### 1.9 Unique and TTL indexes not built in production ({{OPS:indexes}})

| | |
|---|---|
| Severity | **High** (unverified in production) |
| Root cause | `autoIndex: !isProduction` with no migration or `syncIndexes` step |
| Impact | Concurrent duplicates (workspace slug, user email per tenant, webhook event ids, usage counters, subscriptions per tenant); TTL cleanup of tokens and sessions never happens; full collection scans as data grows. The failing concurrent-registration test is the local symptom |
| Remediation | An index migration step in deploy (`Model.syncIndexes()` per model or a migration tool) with a dry-run diff and production verification |
| Production check | List indexes on the production cluster for each collection and compare with model declarations |

### 1.10 Impersonation is an unrestricted user session ({{ADM:impersonation}})

| | |
|---|---|
| Severity | **High** (insider risk; also enables actions attributed to the customer) |
| Root cause | Impersonation issues a normal user token; nothing reads the `impersonation` claim; actions are attributed to the impersonated user; tenant status ignored; daily cap computed from a buffered log |
| Remediation | Read-only by default, write as separate approval; `onBehalfOf` attribution; tenant consent and banner; short TTL; enforce cap atomically |

### 1.11 Scoped support admins are not confined ({{TEN:support-scope}}, {{GOV:auditlog-scope}}, {{TEN:access-approval}})

| | |
|---|---|
| Severity | **High** where scoped support admins exist |
| Root cause | `tenantScope` is embedded in the admin token but `/tenants/:id/*` and `/audit-logs` do not apply it; access-request approval is gated by `adminType`, not a permission, and accepts any role name into any tenant |
| Remediation | Apply `tenantIsolation` with the admin scope on every admin route that takes a tenant id; permission key for approvals; role id with ceiling |

## 2. Medium findings

| Finding | Summary | Remediation |
|---|---|---|
| {{AUTH:refresh-in-body}} | Refresh token and session id returned in the JSON body as well as the HttpOnly cookie | Cookie only for browsers |
| {{AUTH:rate-limit}} | One 20/15-min bucket shared by login, refresh, register, reset, verify for both portals; in-memory store; `TRUST_PROXY=1` assumption unverified | Per-route limiters, per-account limits, Redis store, verified proxy hop count |
| {{AUTH:lockout-rearm}} | Failed-attempt counter never decays; one failure re-locks after the window | Reset on window expiry |
| {{AUTH:logout-noop}} | Bearer-only logout returns 200 and revokes nothing | Authenticate logout; revoke the session from the token |
| {{AUTH:pending-admin}} | `pending` admins can log in; refresh ignores `locked` | Allow-list `active` |
| {{SEC:role-expiry}} | Time-bound role grants are not filtered by `expiresAt` when resolving permissions; cleanup relies on a TTL index that production never builds | Filter by expiry in resolution |
| {{SEC:webhook-replay}} | Inbound webhook HMAC covers only the body; the timestamp header is not signed, so captured requests can be replayed with a fresh timestamp | Sign `timestamp.body`; require the timestamp; store recent signatures |
| {{CON:xlsx}} | Uploaded spreadsheets are fully parsed in memory during the request (decompression-bomb risk) | Size and row limits before parsing; streaming reader; worker-side parsing |
| {{ADM:masterdata}} | Public master-data search builds an unescaped regex; admin writes have no permission check and accept arbitrary fields | Escape or prefix-match; permission key; field allow-list |
| {{API:embed-leak}} | Public embed response (once fixed) returns the full dashboard document including share recipients' emails | Response allow-list |
| {{API:token-in-url}} | Embed, webhook and compliance tokens in URL paths are written to logs | Exchange codes; log redaction |
| {{API:suspension}} | Suspended tenants' API keys and embed tokens keep working | Tenant status check on every key/token use; revoke on suspension |
| {{API:cors-default}} | `EMBED_CORS_ALLOW_ALL` defaults to true | Default false; iframe model (document 09) |
| {{TEN:users-ungated}} | Any member can list members' emails and phone numbers | `users.view` permission; reduced projection for non-admins |
| {{ADM:secrets}} | `iam.tenants.view` can read secret tenant settings in plaintext via `includeSecrets=true` | Separate permission and audit |
| {{FE:query-cache}} | Query cache not cleared on sign-out; next user in the same tab can briefly see the previous tenant's data | Clear and key cache by tenant |
| {{FE:headers}} | No CSP or `frame-ancestors` on the frontend | Vercel headers |
| {{GOV:redaction-gaps}} | Audit snapshots include token hashes, secret hashes, encrypted configuration and raw provider payloads | Allow-list redaction |
| {{CON:webhook-scrypt}} | Each webhook request runs synchronous scrypt key derivation before verifying the signature (CPU amplification) | Cache derived keys; verify cheaply first |

## 3. Low findings and hardening

Socket.IO accepts unauthenticated connections (no feature uses it yet); the `tenantScope` plugin's read filter is dead code and would leak between concurrent requests if enabled ({{TEN:scope-plugin}}); `X-Request-Id` is accepted unbounded from clients; CSV/XLS exports do not neutralise formula prefixes; alert emails can be sent to arbitrary external addresses with a tenant-controlled subject; one HS256 secret signs user, admin, embed and service audiences and is also reused as the compliance-token HMAC key; `JWT_SECRET` has no minimum length check; TOTP codes are replayable within their window; the encryption utility derives keys with synchronous scrypt on every call and does not verify its context hash; the idempotency utility, if ever mounted, keys only on the client header (not actor or tenant) and would replay one user's response to another; `docker-compose.yml` publishes an unauthenticated MongoDB on the host.

## 4. Dependencies

`npm audit --omit=dev`: backend 2 moderate (`uuid < 11.1.1`, GHSA-w5hq-g745-h8pq, via `exceljs`, which parses untrusted uploads; the only automatic fix is a semver-major downgrade, so track an `exceljs` update or isolate parsing in a worker); frontend 0. Key versions are listed in document 01. No lockfile changes were made.

## 5. Secrets hygiene

- No `.env` file is tracked; `.env.example` contains placeholders only.
- The four committed test-output files contain no credential patterns (scan in document 21) but should be removed from the repository.
- `backend/scripts/ci/run-tests.js:39-41` states that the developer `.env` holds real production credentials. Production secrets should live only in the hosting provider's secret store, with separate development and staging credentials, and should be rotated if they have been on developer machines.
- No privileged key reaches the frontend bundle.

## 6. Positive controls (confirmed)

Separate JWT audiences for users and admins; session liveness checked on every authenticated request; refresh-token rotation with reuse detection; tenant suspension revokes sessions; API-key secrets and embed tokens stored as SHA-256 hashes with constant-time comparison; connector credentials and MFA secrets encrypted with AES-256-GCM; Razorpay webhook signature verified over the raw body; production configuration gates refuse insecure defaults; main-API CORS is an allow-list with credentials; Helmet headers and HSTS in production; the engine's leading tenant `$match`; local storage path-traversal protection.

## 7. Production verification required (read-only, by an operator)

1. Which commits are deployed on Render and Vercel.
2. `NODE_ENV`, `EMBED_CORS_ALLOW_ALL`, `TRUST_PROXY`, `REDIS_URL`, `STORAGE_PROVIDER` values (names and non-secret values only).
3. Index list per collection on the production database.
4. Count of `ApiKey`, `EmbedToken`, `AdminRole` with `tenantId`, admins with `tenantScope`.
5. Whether server-side JavaScript is enabled on the database cluster.
6. Egress restrictions on the Render service (private ranges, metadata endpoint).
7. Whether billing permissions were seeded by hand.
