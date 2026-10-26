/**
 * Recommended visualization (ai-ask), derived from the executed query and
 * the ACTUAL result shape - never from the model:
 *   single row, no dimension     -> kpi
 *   bucketed date dimension      -> line
 *   one dimension, <= 6 rows of
 *   non-negative values, no compare -> pie (part-to-whole)
 *   one dimension otherwise      -> bar
 *   anything else                -> table
 * Alternatives only list charts the result can draw: pie/doughnut need one
 * measure with no negative values, scatter needs two measures.
 */
const num = (v) => typeof v === "number" && Number.isFinite(v);

export function recommendVisualization({
  query = {},
  rows = [],
  columns = [],
}) {
  const groupBy = query.groupBy ?? [];
  const dims = groupBy.map((g) => g.field);
  const measures = columns.filter(
    (c) => !dims.includes(c) && rows.some((r) => num(r?.[c])),
  );
  const base = {
    xField: dims[0] ?? null,
    xBucket: groupBy[0]?.bucket ?? null,
    dimensions: dims,
    measures,
  };
  if (!rows.length || !measures.length)
    return { ...base, type: "table", alternatives: ["table"] };
  if (!dims.length) {
    const type = rows.length === 1 ? "kpi" : "table";
    return {
      ...base,
      type,
      alternatives: type === "kpi" ? ["kpi", "table"] : ["table"],
    };
  }
  if (dims.length === 1 && groupBy[0].bucket)
    return {
      ...base,
      type: "line",
      alternatives: ["line", "area", "bar", "table"],
    };
  if (dims.length === 1) {
    if (measures.length >= 2) {
      return {
        ...base,
        type: "bar",
        alternatives: ["bar", "line", "scatter", "table"],
      };
    }
    const first = measures[0];
    const nonNegative = rows.every((r) => num(r?.[first]) && r[first] >= 0);
    const partToWhole = !query.compare && rows.length <= 6 && nonNegative;
    const slices = nonNegative ? ["pie", "doughnut"] : [];
    return {
      ...base,
      type: partToWhole ? "pie" : "bar",
      alternatives: partToWhole
        ? ["pie", "doughnut", "bar", "table"]
        : ["bar", ...slices, "table"],
    };
  }
  return { ...base, type: "bar", alternatives: ["bar", "table"] };
}

export default { recommendVisualization };
