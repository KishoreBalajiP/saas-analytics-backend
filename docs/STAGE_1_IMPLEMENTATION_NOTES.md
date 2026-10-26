# Stage 1 implementation notes (2026-10-25)

Scope: dashboards, data import, Analytics, Ask, metrics UX. Both repos were changed as plain
working-tree edits. Nothing was committed, pushed or deployed, and no production data was touched.

## Root causes fixed

| Problem | Cause | Fix |
|---|---|---|
| A new (draft) dashboard could not be opened | Frontend routing: `dashboards.$dashboardId.tsx` is a child of `dashboards.tsx`, which rendered the list with no `<Outlet />`, so `/dashboards/:id` and `/dashboards/:id/edit` showed the list again. Report and alert detail/edit pages had the same bug. The backend always allowed drafts to be opened. | `dashboards.tsx`, `reports.tsx`, `alerts.tsx` and their `$id` routes are now `<Outlet />` layouts. The pages moved to `*.index.tsx` routes. A regression test checks this. |
| "Create your first dashboard" shown while dashboards exist | The overview setup card printed one generic sentence whenever any step was open. | The message now names the open step and the dashboard count. |
| Widgets drawn on top of each other | Every new widget was saved at `{x:0,y:0}`, and the detail view placed widgets by explicit grid row/column. | The backend puts a widget created without a position in the first free 12-column slot. The view renders in reading order with column spans, and stacks on phones. The editor has width and move controls. |
| Analytics panels misaligned; left panel empty after Run | The tab bar sat outside the left card, so the two cards started at different heights. Running a query switched to a `results` tab that does not exist. | The page is now two aligned cards with matching headers, `minmax(0, …)` columns, and stacked panels below `lg`. The builder no longer switches tabs on Run. |
| Ask said "No AI provider is configured" | The message appears only when the backend's resolved `AI_PROVIDER` is not `gemini`. A missing key or a bad model id was never reported. The deployed host reads its own environment; a local `.env` is not deployed. | `/ai/status` names the actual problem: `AI_NOT_CONFIGURED`, `AI_PROVIDER_UNSUPPORTED`, `AI_API_KEY_MISSING` or `AI_MODEL_INVALID`. Provider and model values are trimmed and stripped of quotes. Provider failures map to `AI_AUTH_FAILED`, `AI_MODEL_UNAVAILABLE`, `AI_RATE_LIMITED`, `AI_PROVIDER_UNREACHABLE` or `AI_TIMEOUT`, without echoing provider text. |
| Ask only looked at the first 20 datasets | `buildContext` took the first 20 schemas in `connectorId` order. When over the size cap it cut the JSON string, so the model received invalid JSON. | Every permitted, live dataset is ranked by name, field and approved-metric matches, and a follow-up keeps its earlier dataset first. The top 20 are offered and the answer reports `scope`. The context shrinks by whole fields or datasets, never by cutting the string. No ready dataset means no model call. |
| Header-less CSV imported 0 rows | csv-parse yields arrays when `hasHeader:false`, and the sync engine skips non-object records. | Cells are named `column_1..N` in both preview and ingest. |

## New behaviour

- **Upload file** (Datasets): choose `.csv`/`.xlsx`, name the dataset (defaults to the file name),
  preview it (header switch, CSV separator, worksheet picker), then create. Two new endpoints:
  - `POST /api/v1/connectors/file-preview` (`connectors.preview`) previews a file. Nothing is stored. The XLSX sheet list is in `meta.sheets`.
  - `POST /api/v1/connectors/import` (`connectors.create` + `connectors.sync`) creates the
    dataset and queues the import in one request. Names are unique per workspace
    (case-insensitive, `409 DATASET_NAME_TAKEN`). Empty, header-only, legacy `.xls` and non-CSV/XLSX
    files are refused. If queueing fails, the new connector is deleted again. The original file
    name is kept on the sync run.
- **Dataset state** (Ready / Processing / Import failed / No data yet) is shown in the list, on the dataset page and in
  pickers. The API refuses queries on a dataset whose *first* import is still running or failed
  (`409 DATASET_NOT_READY`) instead of returning an empty result. A dataset with data stays queryable while it re-syncs.
- **Dashboards**: Create opens the new draft. The editor has two add paths, *Build visually*
  (ready datasets only) and *Ask AI*; both save the validated query, not an image. Delete
  returns to the list. Publish validation, the draft/published rules, and embed and
  external-API restrictions (published only) are unchanged.
- **Analytics**: field suggestions from the selected datasets' schemas. Datasets that are importing or failed
  cannot be selected. Only chart types the query shape supports are offered, and the default
  view follows the recommendation.
- **Ask**: doughnut and scatter are offered when the result supports them. Add to dashboard
  defaults to the chart currently shown.
- **Metrics**: drafts show "Waiting for approval by an Owner or Admin" to users without
  `metrics.approve`. The field input suggests fields from the chosen dataset's schema.

## AI model selection

`AI_PROVIDER` picks the adapter (`noop` | `gemini`). `AI_MODEL` picks the model id, for example `gemini-2.5-flash`
or `gemini-3.6-flash`; it must start with `gemini-`. A bad model id does not stop the API from starting.
It logs a startup warning and Ask reports `AI_MODEL_INVALID`. Set these on the **host** that runs
the backend (Render); the repository's `.env` is not deployed.

## Not done / limits

- No browser run. UI behaviour is covered by component tests and the production build only.
- No live Gemini request was made (fake SDK in tests).
- Cross-dataset joins are not supported. A dashboard can mix datasets per widget.
- Widget layout uses width and move controls, not drag-and-drop.

## Verification (this machine, 2026-10-25)

- Backend `npm test`: 1,595 of 1,606 passed. The 11 failures are 10 in `tests/mfa-tenant/*` and 1 in
  `platform-config/feature-flags` (`connectors.webhooks` evaluates false for an unentitled
  workspace). They fail the same way in a copy with no `.env` and touch code this pass did not change
  (tenant MFA, feature-flag plan gating), so they are left for whoever owns that change.
- New backend suites: `tests/datasets/file-import.integration.test.js` (7, the full CSV workflow at the API
  level, XLSX sheets, header-less CSV, bad files, duplicate names, permissions, isolation, not-ready guard)
  and `tests/ai-ask/ask.config-relevance.test.js` (7). Two older fixtures published an empty
  dashboard; they now add a widget first, since publish validation requires one.
- `scripts/ci/run-tests.js` now also isolates `AI_*` and `RAZORPAY_*` from a developer `.env`.
- `npm run ci:guards`: OK.
- Frontend: `npm test` 806 of 806, `typecheck` 0 errors, `lint` 0 errors (23 existing warnings), `build` OK.
