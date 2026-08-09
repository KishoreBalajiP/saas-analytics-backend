/**
 * Side-effect registration: imports the module barrel so the csv + webhook
 * providers are registered in the ConnectorRegistry before connector tests
 * assert on `listConnectors()`. Imported by connector test files.
 */

import '../../../src/modules/connectors/index.js';

export {};
