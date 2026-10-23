/**
 * Deterministic context assembly (ai-ask). Lists the tenant's datasets with
 * their non-personal fields and the approved metrics. Everything here is
 * tenant-controlled text: it is serialised as JSON inside a delimited data
 * block, names are length-capped, sample values are never sent, and the
 * whole block is capped so a large workspace cannot blow up the prompt.
 */
import { createHash } from "node:crypto";
import { listSchemas } from "../datasetSchema.service.js";
import { isSensitiveFieldName } from "../../utils/sensitiveFields.js";
import { list as listMetrics } from "../metricDefinition.service.js";
// rls: only datasets the caller may query (and see) are offered to the planner.
import { resolveAccessScope } from "../dataAccess.service.js";
import { Connector } from "../../models/Connector.js";

export const CONTEXT_LIMITS = Object.freeze({
  datasets: 20,
  fields: 60,
  name: 100,
  chars: 20000,
});
const cap = (v, n = CONTEXT_LIMITS.name) => String(v ?? "").slice(0, n);

export async function buildContext({ tenantId }) {
  const [all, scope] = await Promise.all([
    listSchemas({ tenantId }),
    resolveAccessScope({ tenantId }),
  ]);
  const blocked = scope.bypass
    ? new Set()
    : new Set([...scope.denied, ...scope.hidden].map(String));
  const schemas = all.filter((s) => !blocked.has(String(s.connectorId)));
  // Dataset names let the planner resolve the dataset from the question alone.
  const picked = schemas.slice(0, CONTEXT_LIMITS.datasets);
  const connectors = await Connector.find({
    tenantId: String(tenantId),
    _id: { $in: picked.map((s) => String(s.connectorId)) },
  })
    .select("name")
    .lean();
  const names = new Map(connectors.map((c) => [String(c._id), c.name]));
  const datasets = picked.map((s) => ({
    id: s.connectorId,
    name: cap(s.name || names.get(String(s.connectorId))),
    dateField: s.dateField ?? null,
    fields: (s.fields ?? [])
      .filter((f) => !f.personal && !isSensitiveFieldName(f.name))
      .slice(0, CONTEXT_LIMITS.fields)
      .map((f) => ({ name: cap(f.name), type: f.type })),
  }));
  const metrics = (
    (await listMetrics({ tenantId, status: "approved" }))?.docs ?? []
  )
    .filter((m) => datasets.some((d) => d.id === String(m.connectorId)))
    .slice(0, 50)
    .map((m) => ({
      ref: `metric:${m.key}`,
      label: cap(m.label),
      datasetId: String(m.connectorId),
      unit: m.unit ?? null,
    }));
  let data = JSON.stringify({ datasets, metrics });
  if (data.length > CONTEXT_LIMITS.chars)
    data = JSON.stringify({
      datasets: datasets.map((d) => ({ ...d, fields: d.fields.slice(0, 15) })),
      metrics: metrics.slice(0, 10),
    }).slice(0, CONTEXT_LIMITS.chars);
  return { datasets, metrics, data };
}

export function hashPrompt(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export default { buildContext, hashPrompt, CONTEXT_LIMITS };
