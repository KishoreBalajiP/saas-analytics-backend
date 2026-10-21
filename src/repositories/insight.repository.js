/** Insight repository (ai-insights): tenant-filtered reads and writes. */
import { Insight } from '../models/Insight.js';

const isId = (id) => /^[0-9a-fA-F]{24}$/.test(String(id));
export async function createMany(docs) {
  if (!docs.length) return [];
  return (await Insight.insertMany(docs)).map((d) => d.toObject());
}
export async function list({ tenantId, dashboardId, metricKey, status = 'open', page = 1, limit = 20 }) {
  const filter = { tenantId: String(tenantId) };
  if (dashboardId) filter.dashboardId = String(dashboardId);
  if (metricKey) filter.metricKey = metricKey;
  if (status) filter.status = status;
  const r = await Insight.paginate(filter, { page, limit, lean: true, sort: { createdAt: -1 } });
  return { docs: r.docs, total: r.totalDocs, page: r.page, limit: r.limit, pages: r.totalPages };
}
export function update({ tenantId, id, set }) {
  if (!isId(id)) return null;
  return Insight.findOneAndUpdate({ _id: id, tenantId: String(tenantId) }, { $set: set }, { new: true, lean: true });
}
export default { createMany, list, update };
