/**
 * Deterministic context assembly (ai-ask). Lists the tenant's datasets with
 * their non-personal fields and the approved metrics. Everything here is
 * tenant-controlled text: it is serialised as JSON inside a delimited data
 * block, names are length-capped, sample values are never sent, and the
 * whole block is capped so a large workspace cannot blow up the prompt.
 *
 * Relevance: every dataset the caller may query is ranked against the
 * question (dataset name, field names, approved metric labels; a follow-up
 * keeps its earlier dataset first) and the top CONTEXT_LIMITS.datasets are
 * offered. Only metadata is scored - no rows are read. `scope` tells the
 * caller how many datasets were available and how many were offered, so a
 * truncated search is reported instead of silently ignoring datasets.
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

// Words that say nothing about WHICH dataset a question is about.
const STOP_WORDS = new Set(
  (
    "a an and are as at be by compare count each for from have how i in is it last " +
    "many me much my number of on or our per show than that the their this to top " +
    "total trend trends vs versus was were what which who with month months monthly " +
    "week weeks weekly year years yearly day days daily today yesterday quarter " +
    "current previous next average avg sum most least highest lowest give list find"
  ).split(" "),
);

function stem(token) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Lower-case word stems of a name or question (snake_case and camelCase split). */
export function tokenize(text) {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map(stem);
}

/**
 * Score one dataset against the question terms: a dataset-name hit weighs
 * 3, an approved-metric label/key hit 2, a field-name hit 1.
 */
export function relevanceScore({ name, fields = [], metricText = "" }, terms) {
  if (!terms.size) return 0;
  const nameTokens = new Set(tokenize(name));
  const fieldTokens = new Set(fields.flatMap((f) => tokenize(f.name)));
  const metricTokens = new Set(tokenize(metricText));
  let score = 0;
  for (const t of terms) {
    if (nameTokens.has(t)) score += 3;
    if (metricTokens.has(t)) score += 2;
    if (fieldTokens.has(t)) score += 1;
  }
  return score;
}

/** Fields that match the question first, so a wide dataset keeps them under the cap. */
function orderFields(fields, terms) {
  if (!terms.size) return fields;
  const hits = [];
  const rest = [];
  for (const f of fields) (tokenize(f.name).some((t) => terms.has(t)) ? hits : rest).push(f);
  return [...hits, ...rest];
}

/**
 * Serialise the context, shrinking it (fewer fields per dataset, then the
 * lowest-ranked datasets, then metrics) until it fits CONTEXT_LIMITS.chars.
 * The JSON is never cut mid-string, so the model always gets valid data.
 */
function fit(datasets, metrics) {
  let ds = datasets;
  let ms = metrics;
  let data = JSON.stringify({ datasets: ds, metrics: ms });
  for (const perDataset of [30, 15, 8]) {
    if (data.length <= CONTEXT_LIMITS.chars) break;
    ds = ds.map((d) => ({ ...d, fields: d.fields.slice(0, perDataset) }));
    data = JSON.stringify({ datasets: ds, metrics: ms });
  }
  while (data.length > CONTEXT_LIMITS.chars && ds.length > 1) {
    ds = ds.slice(0, -1);
    ms = ms.filter((m) => ds.some((d) => d.id === m.datasetId));
    data = JSON.stringify({ datasets: ds, metrics: ms });
  }
  if (data.length > CONTEXT_LIMITS.chars) {
    ms = ms.slice(0, 10);
    data = JSON.stringify({ datasets: ds, metrics: ms });
  }
  return { datasets: ds, metrics: ms, data };
}

export async function buildContext({ tenantId, question = "", preferDatasetIds = [] } = {}) {
  const [all, scope] = await Promise.all([
    listSchemas({ tenantId }),
    resolveAccessScope({ tenantId }),
  ]);
  const blocked = scope.bypass
    ? new Set()
    : new Set([...scope.denied, ...scope.hidden].map(String));
  const permitted = all.filter((s) => !blocked.has(String(s.connectorId)));
  // Only live (not deleted) connectors; a leftover schema is not a dataset.
  const connectors = await Connector.find({
    tenantId: String(tenantId),
    _id: { $in: permitted.map((s) => String(s.connectorId)) },
  })
    .select("name lastSyncedAt updatedAt")
    .lean();
  const live = new Map(connectors.map((c) => [String(c._id), c]));
  const schemas = permitted.filter((s) => live.has(String(s.connectorId)));

  const approved = ((await listMetrics({ tenantId, status: "approved" }))?.docs ?? []).filter(
    (m) => live.has(String(m.connectorId)),
  );
  const metricText = new Map();
  for (const m of approved) {
    const id = String(m.connectorId);
    metricText.set(id, `${metricText.get(id) ?? ""} ${m.key} ${m.label ?? ""}`);
  }

  const terms = new Set(tokenize(question));
  const preferred = new Set(preferDatasetIds.map(String));
  const ranked = schemas
    .map((s) => {
      const id = String(s.connectorId);
      const connector = live.get(id);
      const name = s.name || connector?.name;
      const fields = (s.fields ?? []).filter((f) => !f.personal && !isSensitiveFieldName(f.name));
      return {
        id,
        name,
        fields,
        score: relevanceScore({ name, fields, metricText: metricText.get(id) }, terms) + (preferred.has(id) ? 5 : 0),
        recency: new Date(connector?.lastSyncedAt ?? connector?.updatedAt ?? 0).getTime(),
        dateField: s.dateField ?? null,
      };
    })
    .sort((a, b) => b.score - a.score || b.recency - a.recency || String(a.name).localeCompare(String(b.name)));

  const datasets = ranked.slice(0, CONTEXT_LIMITS.datasets).map((d) => ({
    id: d.id,
    name: cap(d.name),
    dateField: d.dateField,
    fields: orderFields(d.fields, terms)
      .slice(0, CONTEXT_LIMITS.fields)
      .map((f) => ({ name: cap(f.name), type: f.type })),
  }));
  const metrics = approved
    .filter((m) => datasets.some((d) => d.id === String(m.connectorId)))
    .slice(0, 50)
    .map((m) => ({
      ref: `metric:${m.key}`,
      label: cap(m.label),
      datasetId: String(m.connectorId),
      unit: m.unit ?? null,
    }));
  const fitted = fit(datasets, metrics);
  return {
    ...fitted,
    scope: {
      available: ranked.length,
      offered: fitted.datasets.length,
      truncated: fitted.datasets.length < ranked.length,
    },
  };
}

export function hashPrompt(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export default { buildContext, hashPrompt, tokenize, relevanceScore, CONTEXT_LIMITS };
