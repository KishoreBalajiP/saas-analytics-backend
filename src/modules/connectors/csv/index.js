/**
 * CSV provider registration.
 *
 * WHY IT EXISTS
 *   Importing this module registers the CSV connector in the shared
 *   `ConnectorRegistry` at boot (via `src/modules/connectors/index.js`), so
 *   routes / queues / embed can look it up by type without a central edit.
 */

import { registerConnector } from '../../../connectors/index.js';
import { CsvConnector } from './csv.connector.js';

registerConnector(CsvConnector);

export { CsvConnector };
export default CsvConnector;
