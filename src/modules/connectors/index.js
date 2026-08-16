/**
 * Connector module barrel - registers every provider exactly once.
 *
 * WHY IT EXISTS
 *   The `connectors` module owns the concrete providers (`csv`, `webhook`)
 *   built on the Phase 1.1 framework in `src/connectors/`. Importing this
 *   barrel (once, at boot) registers every provider in the shared
 *   `ConnectorRegistry` so routes, queues and the sync worker discover them
 *   by type without knowing concrete class names.
 *
 * HOW TO EXTEND
 *   Add a new provider: create `src/modules/connectors/<type>/`, have its
 *   `index.js` call `registerConnector(...)`, then add one import here.
 */

import './csv/index.js';
import './webhook/index.js';
import './xlsx/index.js';
import './mongodb/index.js';

export {};
