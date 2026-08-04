/**
 * Connector routes (shell).
 *
 * WHY IT EXISTS
 *   Reserve the `/connectors` surface for the future connectors feature. A
 *   "connector" is the generic abstraction for any external data source the
 *   platform can ingest (CSV, Google Sheets, Webhooks, MongoDB, PostgreSQL,
 *   MySQL, REST APIs, GraphQL, Snowflake, BigQuery). Connector implementations
 *   live under `src/connectors/` and `src/modules/connectors/`; this file only
 *   owns the HTTP surface.
 *
 * RESPONSIBILITY
 *   None yet - router is intentionally empty (404 until implemented).
 *
 * HOW TO EXTEND
 *   Build the feature under `src/modules/connectors/` and wire endpoints:
 *   ```
 *   router.use(authenticate, resolveTenant);
 *   router.post('/', validateRequest(createConnectorSchema), connectorController.create);
 *   router.post('/:connectorId/validate', connectorController.validate);
 *   router.post('/:connectorId/preview', connectorController.preview);
 *   router.post('/:connectorId/sync', connectorController.triggerSync);
 *   router.delete('/:connectorId', connectorController.delete);
 *   ```
 *   File uploads (multer, for CSV) should live under the module too.
 */

import { Router } from 'express';

const router = Router();

// Connector endpoints will be registered here.

export default router;
