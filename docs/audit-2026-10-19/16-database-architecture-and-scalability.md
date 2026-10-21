# 16. Database, data model and scalability

**Audience:** engineers responsible for the MongoDB data model, migrations and performance.

**Summary.** The schema is generally well designed: 41 models with explicit tenant ids, compound indexes that match the main query patterns, a shared plugin set and append-only intent for audit data. Three structural problems undermine it. **Production never builds any declared index** ({{DB:indexes}}): `autoIndex` is off when `NODE_ENV=production`, the Dockerfile sets that value, and no migration or `syncIndexes` step exists, so every unique and TTL constraint the code relies on is absent unless someone created it by hand. **There are no transactions and no migration or seed versioning** ({{DB:no-tx}}, {{DB:seed-versioning}}), so multi-document flows can stop halfway and catalogue changes never reach existing tenants. **Counters and cascades are wrong**: usage counters only go up ({{BIL:quota-ops}}), deletes leave live dependent data ({{DB:dangling}}), and tenant suspension stops only sessions ({{API:suspension}}).

## 1. Data model and tenant isolation (brief §17.1)

| Resource | Tenant id on model | Server-side scoping on every route | Notes |
|---|---|---|---|
| Users, memberships (`User`, `UserRole`) | Yes | Yes, from the JWT (`req.user.tenantId`) | `GET /users` lacks a permission gate ({{TEN:users-ungated}}) |
| Roles and permissions | Tenant roles yes; platform roles `tenantId: null` | Admin routes | Platform admins can create roles in any tenant by id without an existence check |
| Connectors (datasets), rows | Yes (`Connector`, `ConnectorRow`) | Yes (repositories + engine leading `$match`) | Rows of deleted connectors remain queryable ({{CON:delete-cascade}}) |
| Analytics queries | Yes | Yes | History has no actor and no TTL |
| Dashboards, widgets | Yes | Yes; HTTP isolation tested | |
| Reports, alerts, events | Yes | Yes | Due-scan queries are global (expected for schedulers) |
| API keys, embed tokens | Yes | **No** on management routes: tenant never resolved; repository drops the filter when the id is falsy ({{TEN:apikey-idor}}) | |
| Usage counters, subscriptions, payments | Yes | Workspace billing routes use `tenantIsolation` on `:id` | |
| Audit, access and compliance logs | Yes (tenant id where applicable) | Admin routes; scoped admins not confined on `/audit-logs` ({{GOV:auditlog-scope}}) | |
| Background jobs | Tenant id carried in messages | Worker passes it to services | In-memory queue unless Redis |
| Cached results | Tenant id in cache key | Yes (`analytics.cache.js:29-42`) | Per-process memory without Redis |
| Export artefacts | Storage keys include tenant and export ids | Download via signed URLs | Never expire ({{GOV:export-expiry}}) |
| AI conversation history | n/a (no AI) | — | Design in document 08 |

**No resource relies on a frontend-supplied tenant id without a backend check**, with two qualifications: `resolveTenant` accepts the `X-Tenant-Id` header for unauthenticated login and reset flows (by design, and it is checked against the JWT once authenticated), and the API-key/embed routes, where no tenant is resolved at all.

The `tenantScope` plugin's read filter is inert (`useScope` is never called) and its design would leak between concurrent requests if enabled ({{DB:inert-guard}}). Isolation therefore depends on every repository passing `tenantId` explicitly; the recommendation is to make missing tenant ids throw in repositories and to add an authorisation-matrix test suite (document 17 §5).

## 2. Database quality (brief §17.2)

| Topic | Finding | Recommendation |
|---|---|---|
| Index provisioning | None in production ({{DB:indexes}}) | A versioned migration step that runs `syncIndexes` per model with a reviewed diff, plus a CI check that compares declared indexes with a test database |
| Unique constraints vs soft delete | Unique indexes include soft-deleted rows, so a deleted user, role or setting blocks re-creation and seeders can fail ({{DB:unique-softdelete}}) | Partial unique indexes with `partialFilterExpression: { deletedAt: null }` where re-creation should be allowed |
| Abandoned signups | A pending tenant plus unverified user reserves the slug forever because the cleanup job is a stub | Reap pending tenants after the verification window |
| Transactions | None anywhere ({{DB:no-tx}}). Registration (tenant → user → token), verification (initialise → activate → consume token), invitation (user → role grant → invitation), payment capture → subscription change can all stop halfway | Use transactions where the cluster is a replica set (Atlas is); otherwise idempotent, resumable steps with an outbox |
| Payment capture ordering | Payment marked captured before the plan change; failure leaves "paid but not upgraded" with no automatic recovery ({{BIL:lost-payments}}) | Transaction or idempotent apply step retried by reconcile, with alerting |
| Optimistic concurrency | Applies to `save()` only; documentation claims it also covers `findOneAndUpdate`, and repository updates never pass the expected version ({{DB:occ}}) | Explicit `__v` conditions on update paths that need it (subscriptions, roles, settings) |
| Expiring grants | Temporary role grants rely on the TTL monitor; permission resolution ignores `expiresAt`, and the TTL index is not built in production ({{SEC:role-expiry}}) | Filter by expiry at resolution |
| Seed and catalogue versioning | Module/permission catalogue and default roles are created once per tenant at onboarding; changes never reach existing tenants ({{DB:seed-versioning}}) | Versioned, idempotent seed migrations applied to all tenants |
| Referential integrity | Dangling references after deletes: deleted connectors still feed analytics; alerts and reports pointing at deleted dashboards or datasets retry forever ({{DB:dangling}}) | Explicit cascades or "orphaned" status with notification |
| Identifier types | `tenantId` is a String everywhere except `WebhookEvent.tenantId` (ObjectId); `Report`/`AlertRule` store dashboard and widget ids as strings | Normalise in a migration |
| Strict-mode drops | `$set` of fields not in the schema (for example `updatedBy` on `User`, `TenantInvitation`, `Notification`) is silently discarded | Add the fields or stop writing them |
| Invitation history | The TTL index on `expiresAt` deletes accepted and revoked invitations as well | TTL only on pending invitations, or a separate `purgeAt` |
| Pagination | The paginate plugin ignores its max limit; some list endpoints accept unbounded limits ({{DB:paginate}}) | Enforce maximums in the plugin |
| Missing indexes for real queries | `Session.tenantId` (used by tenant-wide revocation) is not indexed; scheduler due-queries do not match the tenant-prefixed compound indexes | Add `{tenantId:1,status:1}` on sessions and `{nextRunAt:1,'schedule.enabled':1}` style indexes for due scans |
| Audit volume | Every `findOneAndUpdate` on an audited model writes an audit row, including `lastUsedAt` touches on keys and tokens; `AnalyticsQuery` writes a document per uncached query with no TTL | Exclude heartbeat fields from audit; TTL on query history |
| Erasure | Compliance "delete" is a soft delete; personal data remains in `User` and in denormalised copies (audit snapshots, invitations, access requests) and retention purges never run ({{GOV:dsr}}) | A data map of where personal data lives and an erasure procedure that covers each location |
| Bounded arrays | Report runs are capped; recipient and channel arrays and `Dashboard.shares` are unbounded | Caps in validators |

## 3. Background jobs and schedulers (brief §17.3)

Covered in document 12 §2. In short: two real per-minute jobs without locks or claims, four stub jobs, dead stale-job recovery, in-process workers, and an in-memory queue fallback that loses jobs on restart.

## 4. Performance and scale (brief §17.4)

No throughput, latency or capacity was measured; nothing here should be read as a current figure.

| Likely bottleneck | Why | Recommendation |
|---|---|---|
| Analytics over `ConnectorRow` | All tenants' rows live in one collection with schemaless `data`. Filters run inside `$expr` on `data.*`, which cannot use indexes; the only indexed predicates are tenant, connector and `ingestedAt`. The `$facet` count scans every matching row | Extract the business date (and, later, a few declared key fields) into typed top-level fields at ingestion and index `{tenantId, connectorId, eventAt}`; avoid `$facet` totals for large results (estimated counts or separate capped count); per-tenant concurrency limits |
| Dashboard load | Up to 30 widgets executed concurrently per view, including from the public embed route | Per-dashboard concurrency limit, shared result cache keyed by dataset version, pre-computed rollups for heavy widgets |
| Large imports | CSV buffer base64-encoded into the queue message; XLSX fully materialised; MongoDB sync reads up to 100,000 documents without timeouts | Stage files in object storage; stream parsing; chunked bulk writes; per-sync row caps |
| Caching | In-memory per process unless Redis is configured; TTL 5 minutes; no invalidation on sync | Redis cache in production; dataset-version keys |
| Audit and access logging | Synchronous audit writes on many updates; buffered access-log writes not flushed on shutdown | Asynchronous outbox; exclude heartbeat updates |
| Multi-instance | Rate limits, Socket.IO and cron are per process | Redis-backed limiter and adapter; scheduler in a single worker |
| Growth without retention | Audit, access, login-attempt, session, query-history and export data grow unbounded | Retention job (document 12) |

**Measurable objectives to adopt after a baseline** (targets to be set by the team from measurements): p95 dashboard view time for a 10-widget dashboard over 1 million rows; p95 analytics query time by query class; CSV sync throughput (rows per second) and maximum supported file size; scheduled-report punctuality; API error rate; MongoDB CPU and connection utilisation at peak.

**Load tests to run** (staging, synthetic data): a tenant with 1, 5 and 20 million rows; 50 concurrent users per tenant opening dashboards; 10 tenants syncing 10 MB CSVs concurrently; two app instances plus one worker; mixed external API traffic at the per-key limit. Record results in this folder.

**On replacing the query engine:** there is no evidence yet that MongoDB aggregation is the limiting factor; the bottlenecks above are design choices that can be fixed in place. Revisit a columnar store only if load tests show aggregation latency limits after typed fields, indexes and rollups are in place.

## 5. Reliability and recovery (brief §17.5)

See document 12 §4. The database-specific evidence needed: confirmation that the production cluster is a replica set with continuous backup or point-in-time recovery, its retention window, and a recorded restore drill.

## 6. Findings in this area

{{DB:indexes}}, {{DB:no-tx}}, {{DB:seed-versioning}}, {{DB:unique-softdelete}}, {{DB:dangling}}, {{DB:occ}}, {{DB:paginate}}, {{DB:inert-guard}}, {{BIL:quota-ops}}, {{BIL:lost-payments}}, {{SEC:role-expiry}}, {{API:suspension}}, {{GOV:dsr}}. Full details are in `19-findings-register.md`.
