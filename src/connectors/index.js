/**
 * Connector framework - public entry point.
 *
 * WHY IT EXISTS
 *   Lets the rest of the codebase import the connector framework from one
 *   place instead of reaching into individual files.
 *
 * RESPONSIBILITY
 *   Re-export the base contract, the registry and a singleton registry
 *   facade used across routes/jobs/queues.
 *
 * HOW TO EXTEND
 *   - New connector framework helpers belong in this folder and should be
 *     re-exported here.
 *   - Concrete connectors belong in `src/modules/connectors/<type>/` and
 *     register themselves through `registerConnector`.
 */

import BaseConnector from './BaseConnector.js';
import {
  registerConnector,
  hasConnector,
  getConnector,
  listConnectors,
  createConnector,
} from './ConnectorRegistry.js';

export {
  BaseConnector,
  registerConnector,
  hasConnector,
  getConnector,
  listConnectors,
  createConnector,
};

/** Convenience facade for feature code: `connectors.create('mongodb', ctx)`. */
export const connectors = {
  register: registerConnector,
  has: hasConnector,
  get: getConnector,
  list: listConnectors,
  create: createConnector,
};

export default connectors;
