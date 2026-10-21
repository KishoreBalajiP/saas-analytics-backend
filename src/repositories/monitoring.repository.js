/**
 * Monitoring repository: platform-wide, count-only reads for the admin
 * monitoring surface (roadmap 2.8).
 *
 * SCOPE
 *   These queries intentionally span tenants: they back the platform
 *   operator's health page (adminAuth + monitoring.view) and return only
 *   aggregate counts, never tenant records or identifiers.
 */

import Connector from '../models/Connector.js';

/**
 * Connector counts by lifecycle status and by sync status, plus the number
 * of connectors whose last sync failed.
 *
 * @param {Object} [options]
 * @param {number} [options.maxTimeMS=1500]
 * @returns {Promise<{ total: number, byStatus: Object<string, number>, bySyncStatus: Object<string, number> }>}
 */
export async function connectorStatusSummary({ maxTimeMS = 1500 } = {}) {
  const [facet] = await Connector.aggregate([
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
        bySyncStatus: [{ $group: { _id: '$syncStatus', n: { $sum: 1 } } }],
      },
    },
  ]).option({ maxTimeMS });
  const toMap = (rows = []) => Object.fromEntries(rows.map((row) => [String(row._id ?? 'unknown'), row.n]));
  const byStatus = toMap(facet?.byStatus);
  return {
    total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
    byStatus,
    bySyncStatus: toMap(facet?.bySyncStatus),
  };
}

export default { connectorStatusSummary };
