/**
 * API key usage metering (devapi package, roadmap 3.3).
 *
 * record()  - count one external request (key, UTC day, endpoint pattern, status)
 * summary() - per-day totals and per-endpoint/status counts for one key
 */

import mongoose from 'mongoose';
import { ApiKeyUsage } from '../models/ApiKeyUsage.js';
import ApiError from '../utils/ApiError.js';

const dayOf = (d = new Date()) => d.toISOString().slice(0, 10);

/** Best effort: metering never fails the request. */
export async function record({ tenantId, keyId, endpoint, status, at = new Date() }) {
  if (!tenantId || !keyId) return;
  try {
    await ApiKeyUsage.updateOne(
      { tenantId: String(tenantId), keyId, day: dayOf(at), endpoint: String(endpoint).slice(0, 200), status: Number(status) },
      { $inc: { count: 1 } },
      { upsert: true },
    );
  } catch {
    // metering is advisory
  }
}

/**
 * Usage for one key over the last `days` UTC days (1..90).
 * @returns {Promise<{ days: Array<{day, total, errors}>, byEndpoint: Array<{endpoint, status, count}>, total }>}
 */
export async function summary({ tenantId, keyId, days = 7 }) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 90) {
    throw ApiError.badRequest('Validation failed', [{ field: 'days', message: 'must be an integer between 1 and 90' }]);
  }
  if (!mongoose.isValidObjectId(keyId)) throw ApiError.notFound('API key not found');
  const since = new Date(Date.now() - (n - 1) * 24 * 60 * 60 * 1000);
  const rows = await ApiKeyUsage.find({ tenantId: String(tenantId), keyId, day: { $gte: dayOf(since) } }).lean();
  const perDay = new Map();
  for (let i = 0; i < n; i += 1) perDay.set(dayOf(new Date(since.getTime() + i * 86400000)), { total: 0, errors: 0 });
  const perEndpoint = new Map();
  let total = 0;
  for (const r of rows) {
    const d = perDay.get(r.day) ?? { total: 0, errors: 0 };
    d.total += r.count;
    if (r.status >= 400) d.errors += r.count;
    perDay.set(r.day, d);
    const k = `${r.endpoint}|${r.status}`;
    perEndpoint.set(k, (perEndpoint.get(k) ?? 0) + r.count);
    total += r.count;
  }
  return {
    total,
    days: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v })),
    byEndpoint: [...perEndpoint.entries()]
      .map(([k, count]) => {
        const [endpoint, status] = k.split('|');
        return { endpoint, status: Number(status), count };
      })
      .sort((a, b) => b.count - a.count),
  };
}

export default { record, summary };
