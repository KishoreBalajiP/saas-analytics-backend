/**
 * Monitoring Service (architecture placeholder).
 *
 * PURPOSE
 *   Read-only operational health probes. Talks to every subsystem via
 *   the adapter it owns (websocket, queue, jobs, storage, connectors).
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - getSystemHealth, getDbHealth, getWsHealth, getQueueHealth,
 *     getSchedulerHealth, getStorageHealth, getConnectorHealth,
 *     getAggregateHealth, getMetrics
 *
 * CODING GUIDELINES
 *   - Every probe has a 2-second timeout; failures degrade gracefully.
 *   - Probes never throw to the caller; they return structured results.
 *   - `/aggregate` is the one place that fans out to many subsystems.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const getSystemHealth = notImplementedStub('monitoring.service', 'getSystemHealth');
export const getDbHealth = notImplementedStub('monitoring.service', 'getDbHealth');
export const getWsHealth = notImplementedStub('monitoring.service', 'getWsHealth');
export const getQueueHealth = notImplementedStub('monitoring.service', 'getQueueHealth');
export const getSchedulerHealth = notImplementedStub('monitoring.service', 'getSchedulerHealth');
export const getStorageHealth = notImplementedStub('monitoring.service', 'getStorageHealth');
export const getConnectorHealth = notImplementedStub('monitoring.service', 'getConnectorHealth');
export const getAggregateHealth = notImplementedStub('monitoring.service', 'getAggregateHealth');
export const getMetrics = notImplementedStub('monitoring.service', 'getMetrics');

export default {
  getSystemHealth, getDbHealth, getWsHealth, getQueueHealth,
  getSchedulerHealth, getStorageHealth, getConnectorHealth,
  getAggregateHealth, getMetrics,
};
