/**
 * Webhook provider registration.
 *
 * WHY IT EXISTS
 *   Importing this module registers the webhook connector in the shared
 *   `ConnectorRegistry` at boot (via `src/modules/connectors/index.js`), so
 *   routes / queues / embed can look it up by type without a central edit.
 */

import { registerConnector } from '../../../connectors/index.js';
import { WebhookConnector } from './webhook.connector.js';

registerConnector(WebhookConnector);

export { WebhookConnector };
export default WebhookConnector;
