/**
 * XLSX provider registration.
 *
 * WHY IT EXISTS
 *   Importing this module registers the XLSX connector in the shared
 *   `ConnectorRegistry` at boot, so routes / queues / embed can look it up
 *   by type without a central edit.
 */

import { registerConnector } from '../../../connectors/index.js';
import { XlsxConnector } from './xlsx.connector.js';

registerConnector(XlsxConnector);

export { XlsxConnector };
export default XlsxConnector;