/**
 * Webhook replay store.
 *
 * WHY IT EXISTS
 *   A timestamp-bound signature stops a captured delivery from being
 *   replayed AFTER its tolerance window, but not within it. This store
 *   remembers every accepted signature for slightly longer than the window
 *   and refuses a second delivery carrying the same one.
 *
 * HOW
 *   An atomic `SET NX EX` claim in the shared cache (Redis in production,
 *   so all API instances see the same claims). The key is a hash of the
 *   connector id and the signature - never the signature itself.
 *
 * FAILURE MODE
 *   If the cache is unavailable the claim throws and the request is refused
 *   with 503 (fail closed): accepting it would silently disable replay
 *   protection.
 */

import crypto from 'node:crypto';
import * as cacheService from '../../../services/cache.service.js';
import { ConnectorError, CONNECTOR_ERROR_CODES } from '../shared/errors.js';

const PREFIX = 'webhook:replay:';

function keyFor(connectorId, signature) {
  const digest = crypto.createHash('sha256').update(`${connectorId}:${signature}`).digest('base64url').slice(0, 32);
  return `${PREFIX}${connectorId}:${digest}`;
}

/**
 * Claim a delivery. Returns true the first time a signature is seen for a
 * connector within `ttlSeconds`, false for a replay.
 *
 * @throws {ConnectorError} 503 when the replay store is unavailable.
 */
export async function claimDelivery({ connectorId, signature, ttlSeconds }) {
  try {
    return await cacheService.setIfAbsent(keyFor(connectorId, signature), 1, Math.max(1, Math.ceil(ttlSeconds)));
  } catch (error) {
    throw new ConnectorError(
      CONNECTOR_ERROR_CODES.WEBHOOK_REPLAY_CHECK_UNAVAILABLE,
      'The webhook could not be verified right now. Retry later.',
      { statusCode: 503, cause: error },
    );
  }
}

/** Forget a claim (the delivery was refused for a retryable reason). */
export async function releaseDelivery({ connectorId, signature }) {
  await cacheService.del(keyFor(connectorId, signature)).catch(() => {});
}

export default { claimDelivery, releaseDelivery };
