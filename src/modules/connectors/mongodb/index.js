/**
 * MongoDB provider registration.
 *
 * WHY IT EXISTS
 *   Importing this module registers the MongoDB connector in the shared
 *   `ConnectorRegistry` at boot, so routes / queues / embed can look it up
 *   by type without a central edit.
 */

import { registerConnector } from '../../../connectors/index.js';
import { MongoDBConnector } from './mongodb.connector.js';

registerConnector(MongoDBConnector);

export { MongoDBConnector };
export default MongoDBConnector;