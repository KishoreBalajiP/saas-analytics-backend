/**
 * ConnectorRegistry - dynamic lookup + instantiation of connectors.
 *
 * WHY IT EXISTS
 *   The platform must discover connectors by type at runtime (from routes,
 *   jobs, queues and embed widgets) without every caller knowing the concrete
 *   class. This registry is the single place where connector type -> class is
 *   mapped, so adding a connector never requires touching calling code.
 *
 * RESPONSIBILITY
 *   - `register(type, ConnectorClass)` - declare a connector implementation.
 *   - `get(type)` / `has(type)` / `list()` - inspect what is available.
 *   - `create(type, context)` - factory that instantiates a connector with a
 *     validated runtime context (id, config, tenantId).
 *
 * HOW TO EXTEND
 *   Each connector implementation registers itself once, at boot (or when the
 *   module is loaded), e.g. from `src/modules/connectors/<type>/index.js`:
 *
 *   ```js
 *   import { registerConnector } from '../../connectors/index.js';
 *   import MongoDbConnector from './mongodb.connector.js';
 *
 *   registerConnector(MongoDbConnector);
 *   ```
 *
 *   Validation: classes must extend `BaseConnector` and carry a unique static
 *   `type`. Duplicate types are rejected loudly so typos fail fast.
 */

import BaseConnector from './BaseConnector.js';

/** Registry map: connector type -> connector class. */
const registry = new Map();

/**
 * Register a connector class. Throws when the class is invalid or the type
 * is already taken.
 *
 * @param {typeof BaseConnector} ConnectorClass
 */
export function registerConnector(ConnectorClass) {
  if (typeof ConnectorClass !== 'function' || !(ConnectorClass.prototype instanceof BaseConnector)) {
    throw new Error('ConnectorRegistry.registerConnector: class must extend BaseConnector');
  }

  const type = ConnectorClass.type;
  if (!type || type === 'base') {
    throw new Error('ConnectorRegistry.registerConnector: class must declare a static "type"');
  }
  if (registry.has(type)) {
    throw new Error(`ConnectorRegistry.registerConnector: connector type "${type}" is already registered`);
  }

  registry.set(type, ConnectorClass);
  return ConnectorClass;
}

/** True when a connector of the given type is registered. */
export function hasConnector(type) {
  return registry.has(type);
}

/** Return the connector class for a type (undefined when unknown). */
export function getConnector(type) {
  return registry.get(type);
}

/** List metadata for every registered connector (sorted by type). */
export function listConnectors() {
  return [...registry.values()]
    .map((ConnectorClass) => new ConnectorClass().getMetadata())
    .sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * Instantiate a connector for a runtime context.
 *
 * @param {string} type - registered connector type.
 * @param {Object} [context] - { id, config, tenantId }.
 * @returns {BaseConnector}
 * @throws when the type is not registered (fail fast, never silently null).
 */
export function createConnector(type, context = {}) {
  const ConnectorClass = registry.get(type);
  if (!ConnectorClass) {
    throw new Error(`ConnectorRegistry.createConnector: unknown connector type "${type}"`);
  }
  return new ConnectorClass(context);
}
