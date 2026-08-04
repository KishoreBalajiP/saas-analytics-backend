# Connector: CSV

Planned scope - NOT implemented in Phase 1.1.

Future responsibilities (implemented as a `BaseConnector` subclass):

- Accept uploaded CSV/XLSX files (stored via `src/storage/`)
- Stream-parse large files without loading them into memory
- Validate header/row structure and coerce types
- Support field mapping (`shared/`) from file columns to target fields
- Ingest rows through the pipeline (batched, via `src/queues/connector.queue.js`)

Hook points already prepared:
- `uploads/` directory reserved for uploaded files
- `config/constants.js` -> `UPLOAD` limits (size / allowed extensions)
- `src/routes/connector.routes.js` - file-upload endpoint will live here
- `src/storage/` - abstracts local vs S3 file storage

Suggested layout once implemented:

```text
csv/
├── csv.connector.js      # extends BaseConnector
├── csv.parser.js         # streaming parse + type coercion
├── csv.routes.js         # upload + import endpoints
└── csv.test.js           # unit tests
```
