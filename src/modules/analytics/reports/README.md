# Analytics / reports

Reports are **scheduled or one-shot deliverables** that produce a frozen
artefact (CSV / XLSX / PDF) and deliver it via email or download.

## Why it exists

Customers need to share insights with people who don't have a login.
Reports give them a signed URL or email delivery; the report itself
remains a record of the query at run-time.

## Data shape (architecture only)

`models/Report.js`:

```
_id, tenantId, ownerId,
name, description?,
parameters: json,                        // user-supplied query inputs
schedule?: {
  cron,                                 // node-cron compatible
  timezone,
  channel: 'email' | 'webhook',
  recipients: Array<{ type: 'user'|'external', value: string }>,
},
resultKey?: string,                      // latest artefact (storage)
resultStatus: 'pending' | 'running' | 'ready' | 'failed',
lastRunAt?, lastDurationMs?, lastError?,
nextRunAt?,                              // scheduler projection
createdAt, updatedAt
```

## Planned endpoints (`/api/v1/reports`)

- `GET    /`                  - list
- `POST   /`                  - create
- `GET    /:id`               - detail + latest run status
- `PATCH  /:id`               - update parameters / schedule
- `POST   /:id/run`           - ad-hoc run (queued)
- `DELETE /:id`               - delete (soft)
- `GET    /:id/download`      - returns latest presigned URL (or signed
                                  public link)

## Architectural shape

- Controller: `src/controllers/report.controller.js`.
- Service: `src/services/report.service.js` - validates params, queues
  runs through `src/queues/analytics.queue.js`, persists run state.
- Model: `src/models/Report.js`.

## Coding guidelines

- Result artefacts live in `src/storage/`, not Mongo.
- Reports store their **parameters** at run-time, not a link to a query
  that could change later.
- Every run produces an entry into `governance/audit-logs/`.
- Sensitive parameters (e.g. customer IDs) cannot be embedded into the
  generated file if `redact: true` is set.

## Future extension

- Multi-recipient channel matrix (different users get different formats).
- Saved filters / parameters.
- Cross-tenant reports (Phase 4+) for managed accounts.
