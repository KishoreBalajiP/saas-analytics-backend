# Connector: Google Sheets

Planned scope - NOT implemented in Phase 1.1.

Future responsibilities (implemented as a `BaseConnector` subclass):

- OAuth 2.0 / service-account auth for reading Sheets
- Read a spreadsheet's named ranges / tabs
- Convert cell values to typed records (numbers, dates, booleans)
- Scheduled + manual sync (see `src/jobs/sheetSync.job.js`)
- Emit sync results for dashboards/analytics

Hook points already prepared:
- `src/jobs/sheetSync.job.js` - scheduled sync job stub (all sync logic will
  call the connector contract, never the Google SDK directly)
- `src/connectors/BaseConnector.js` - contract this connector will extend
- `utils/encryption.js` - will store OAuth tokens / refresh tokens encrypted

Suggested layout once implemented:

```text
google-sheets/
├── google-sheets.connector.js
├── google-sheets.client.js    # thin wrapper over the googleapis SDK
├── google-sheets.routes.js    # connect + sync endpoints
└── google-sheets.test.js
```
