# Backup and restore runbook

> **What this is:** how Analivo data is backed up, how it is restored, and the
> quarterly drill that proves it. Roadmap item 2.9 (findings ops.02, ops2.03).
> **Who uses it:** the on-call engineer and the platform owner.
> **Status:** procedures and tooling are in the repository; the checklist items
> marked **[operator]** have to be done (and re-confirmed) in the hosting
> consoles. Nothing here is automatic until those are done.

## 1. Objectives

| Target | Value | Notes |
|---|---|---|
| RPO (data loss window), database | 15 minutes or less | Requires Atlas continuous cloud backup with point-in-time restore (PITR). Snapshot-only backup gives an RPO of the snapshot interval (often 24 hours). |
| RTO (time to restore service), full cluster | 4 hours | Measured in every drill (section 5). Restore to a new cluster, repoint `MONGODB_URI`, restart. |
| RTO, one workspace | 1 business day | Restore a snapshot to a scratch cluster, export the workspace, clone it back (section 6). |
| Backup retention | at least 30 days of PITR, 12 monthly snapshots | Confirm against customer contracts. |

These are the proposed targets. The platform owner confirms them and records any
change here.

## 2. What is protected and how

| Asset | Primary protection | Restore path |
|---|---|---|
| MongoDB (all tenants) | Atlas continuous cloud backup + PITR **[operator]** | Atlas restore to a new cluster (section 5.1) |
| One workspace's data | Atlas PITR, plus the owner's own **tenant data export** archives | Section 6 |
| Object storage (S3): connector uploads, report artefacts, export archives | Bucket versioning + lifecycle rules **[operator]** | Restore a prior object version |
| Configuration and secrets (`JWT_SECRET`, `ENCRYPTION_KEY`, SMTP, Razorpay, S3, Redis) | Inventory and copies in a secret manager, not on laptops **[operator]** | Re-enter in Render/Vercel from the secret manager |
| Code and infrastructure settings | Git + Render/Vercel settings export | Redeploy |

**`ENCRYPTION_KEY` is a single point of failure.** Connector credentials are
encrypted with keys derived from it (`src/utils/encryption.js`). A database
backup restored without the matching `ENCRYPTION_KEY` (and
`ENCRYPTION_KEY_VERSION`) cannot decrypt any connector credential. Escrow both
in the secret manager with the date they were set, and restore them together
with the database.

## 3. Point-in-time recovery checklist (do on setup, re-confirm every quarter)

1. **[operator]** Atlas > the production project > the cluster > *Backup*:
   continuous cloud backup is **on**, and *Continuous Cloud Backup* (PITR) is
   enabled. Record the restore window (for example "last 7 days to the
   minute").
2. **[operator]** Snapshot schedule and retention match section 1 (hourly or
   daily snapshots, daily kept 7+ days, weekly 4+ weeks, monthly 12 months).
   Screenshot the policy page for the evidence record.
3. **[operator]** The cluster is a replica set (PITR needs the oplog). Check the
   cluster tier supports cloud backup (M10 and above).
4. **[operator]** Backup alerts are on: failed snapshot, PITR window shrinking,
   backup storage near quota.
5. **[operator]** Who can restore: list the Atlas users with *Project Owner* or
   *Backup Manager*. At least two people, MFA on.
6. **[operator]** S3 bucket: versioning **on**; lifecycle rules:
   - `storage/tenant-exports/` expire current versions after 7 days (the app
     deletes archives after `TENANT_EXPORT_TTL_HOURS`; this rule is the second
     line of defence) and noncurrent versions after 1 day;
   - `storage/audit/exports/` expire after 2 days;
   - noncurrent versions of everything else expire after 30 days.
7. **[operator]** Secret manager holds every variable from `.env.example`
   that is set in production, with owner and rotation date, including
   `ENCRYPTION_KEY` and `ENCRYPTION_KEY_VERSION`.
8. Record the date and the person in the evidence log (section 7).

## 4. Tenant data export (what the product provides)

- Workspace Owners: *Settings > Data export* (`POST /workspace/data-exports`,
  permission `data_exports.export`; only the Owner role has it by default).
  Platform admins: *Admin > Tenants > tenant > Data export*
  (`POST /tenants/:id/data-exports`, `iam.tenants.export`, a support reason is
  required; works for suspended or disabled workspaces).
- The archive (`.tar.gz`) contains `manifest.json` (counts, SHA-256 per file,
  an order-independent content checksum per collection, the list of excluded
  collections with reasons, redactions), one JSON-lines file per collection,
  one CSV per dataset and `reference/permissions.jsonl`.
- Never included: password hashes, connector credentials and webhook tokens
  (redacted), secret settings (redacted), sessions, API keys, embed tokens,
  invitation and reset tokens, platform records. The classification of every
  collection lives in `src/services/tenantDataCatalogue.js`, and a test fails
  when a new collection is not classified.
- One export in flight per workspace, `TENANT_EXPORT_DAILY_LIMIT` (3) requests a
  day, archives expire after `TENANT_EXPORT_TTL_HOURS` (72), download links
  after `TENANT_EXPORT_DOWNLOAD_URL_TTL_SECONDS` (300). The hourly
  `tenant-export-expiry` job deletes expired archives and fails exports that
  were never picked up or whose worker died. Watch it in *Admin > Monitoring >
  Jobs*.
- Requests, link issuance, downloads, completion, failure and expiry are on
  the audit trail (module `data_exports`).

An export is a per-collection read while the job runs, not a point-in-time
snapshot. It is a portability and verification tool, not a substitute for
Atlas backups.

## 5. Quarterly restore drill

Run once a quarter and after any change to backup settings, the data model or
the hosting. Two parts; record both in the evidence log.

### 5.1 Full cluster restore (Atlas)

1. **[operator]** Atlas > *Backup* > *Restore* > choose a point in time
   (for example 30 minutes ago) > restore to a **new scratch cluster** (never
   the production cluster). Start a timer.
2. When the restore finishes, connect read-only with `mongosh` and compare
   document counts of `tenants`, `users`, `connectorrows`, `dashboards` with
   production (counts close to production minus the last 30 minutes).
3. Optional smoke test: a scratch Render service with `MONGODB_URI` set to the
   scratch cluster, `PROCESS_ROLE=web`, `SCHEDULER_ENABLED=false`, no real SMTP;
   log in as a test workspace and open a dashboard.
4. Stop the timer: that is the measured RTO for the database part.
5. Delete the scratch cluster (it holds production data).

### 5.2 Workspace export and restore (`npm run db:restore-drill`)

1. Use a dedicated drill workspace with representative data (connectors,
   dashboards, reports, alerts). As its Owner: *Settings > Data export > Export
   data*, wait for *Completed*, download the archive. Note its SHA-256 from the
   export list.
2. Start a scratch MongoDB (for example `docker run --rm -p 27999:27017 mongo:7`)
   or use the scratch cluster from 5.1. The target must be passed explicitly;
   the drill never reads `MONGODB_URI`.
3. Run:

   ```bash
   npm run db:restore-drill -- \
     --source ./analivo-export-<slug>-<date>-<exportId>.tar.gz \
     --target mongodb://127.0.0.1:27999/restore_drill_2026q4 \
     --expect-sha256 <sha256 from the export list> \
     --operator "<your name>" \
     --report-dir ./restore-drill-reports
   ```

   - `--mode clone` (default) restores as a new, disabled workspace with every
     id remapped; `--mode preserve` keeps the original ids (empty scratch
     database only).
   - The drill refuses the default local database (`127.0.0.1:27017/saas_analytics`),
     the configured `MONGODB_URI`, `mongodb+srv://` and `*.mongodb.net` hosts and
     production-looking database names unless `--allow-unsafe-target` is given.
     Do not pass that flag for a drill.
4. The drill verifies the archive (every file's size and SHA-256, no
   unexpected files, record ownership), restores it, builds the model indexes,
   reads the workspace back and recomputes every collection's count and
   content checksum against the manifest, then writes
   `restore-drill-<timestamp>.json` and `.md`. Exit code 0 = passed,
   1 = failed, 2 = refused.
5. Attach the Markdown report to the evidence log. Drop the scratch database.

## 6. Restoring one workspace (customer request) **[approval]**

Needs the platform owner's approval and a ticket; it writes into production.

1. Restore an Atlas snapshot or point in time from before the incident to a
   scratch cluster (5.1, steps 1-2).
2. Run a scratch deployment against it (5.1 step 3) and, as a platform admin
   there, export the workspace (*Admin > Tenants > tenant > Data export*).
   Download the archive.
3. Rehearse first: `npm run db:restore-drill -- --source <archive> --target <scratch-uri>`.
4. Clone into production as a new, disabled workspace:

   ```bash
   npm run db:restore-drill -- --source <archive> --target "<production MONGODB_URI>" \
     --mode clone --allow-unsafe-target --operator "<name>" --report-dir ./restore-reports
   ```

   The clone gets new ids, a new slug (`<slug>-restore-<suffix>`), status
   `disabled`, and marked payment order ids, so it cannot collide with or act
   as the original. Copy back the records the customer needs, or hand the
   clone to the customer, then re-enable it from the admin portal.
5. After any restore: users reset their passwords (hashes are not exported),
   connectors are reconfigured (credentials are not exported), API keys and
   embed links are re-issued, pending invitations are re-sent.

## 7. Evidence log template

Copy for each drill into the team's evidence store (not this repository).

| Field | Value |
|---|---|
| Date / operator / reviewer | |
| PITR checklist (section 3) confirmed | yes/no, screenshot links |
| PITR window and snapshot retention seen in Atlas | |
| Full cluster restore: point in time chosen, start, end, measured RTO | |
| Count comparison (tenants, users, connectorrows, dashboards) | |
| Workspace drill: export id, archive SHA-256, drill result, report file | |
| Restore drill duration (`timings.totalMs`) | |
| Issues found and follow-up tickets | |
| Next drill due | |

## 8. Scenarios

| Scenario | Action |
|---|---|
| A workspace deleted its own data by mistake | Section 6 from the last good point in time |
| Bad deploy corrupted documents | Stop writes (scale web to 0 / maintenance), PITR to a new cluster just before the deploy, repoint `MONGODB_URI`, redeploy the previous release |
| Cluster or region loss | Restore the latest snapshot / PITR to a new cluster (another region if needed), repoint, restore secrets from the secret manager |
| S3 objects deleted | Restore the previous object versions (versioning) |
| `ENCRYPTION_KEY` lost | Restore it from the secret manager. Without it connector credentials are unrecoverable: every connector must be reconfigured by its workspace |
| Leaked export archive | Delete it now (*Delete archive* in the export list, `DELETE /workspace/data-exports/:exportId` or `DELETE /tenants/:id/data-exports/:exportId`); links stop working at once. Review the `data_exports` audit trail for who issued links and downloaded |
