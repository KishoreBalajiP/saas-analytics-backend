/**
 * Deterministic insight computations (ai-insights, roadmap 4.A3). Pure
 * functions over aggregated cells; every insight carries the cells it was
 * computed from (`cells`, keyed by id) so any narrative number can be
 * traced back. Statistical guards suppress insights on thin data.
 */

export const GUARDS = Object.freeze({
  minRelativeChange: 0.05, // 5%: smaller period changes are not reported
  minMembers: 3, // top movers / contribution need at least this many members
  minOutlierPoints: 7, // outliers need a baseline of at least this many points
  outlierK: 3.5, // robust z (MAD) threshold
});

const round = (n, d = 4) => (n === null || n === undefined ? null : Number(n.toFixed(d)));

/** Period-over-period change of one value. Null when guarded out. */
export function periodChange({ current, previous, label = 'value' }, guards = GUARDS) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const change = current - previous;
  const pct = previous === 0 ? null : change / Math.abs(previous);
  if (pct !== null && Math.abs(pct) < guards.minRelativeChange) return null;
  if (pct === null && change === 0) return null;
  return {
    type: 'period_change',
    cells: { current: { label: `${label} (current)`, value: current }, previous: { label: `${label} (previous)`, value: previous } },
    facts: { change: round(change), changePct: pct === null ? null : round(pct) },
  };
}

/** Members ranked by absolute change; with contribution share (additive metrics). */
export function topMovers({ currentByMember, previousByMember, label = 'value', limit = 3 }, guards = GUARDS) {
  const members = [...new Set([...Object.keys(currentByMember), ...Object.keys(previousByMember)])];
  if (members.length < guards.minMembers) return null;
  const rows = members.map((m) => {
    const c = Number(currentByMember[m] ?? 0);
    const p = Number(previousByMember[m] ?? 0);
    return { member: m, current: c, previous: p, change: c - p };
  });
  const total = rows.reduce((s, r) => s + r.change, 0);
  rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.member.localeCompare(b.member));
  const top = rows.slice(0, limit);
  const cells = {};
  top.forEach((r, i) => {
    cells[`m${i}_current`] = { label: `${label} ${r.member} (current)`, value: r.current };
    cells[`m${i}_previous`] = { label: `${label} ${r.member} (previous)`, value: r.previous };
  });
  cells.total_change = { label: `${label} total change`, value: total };
  return {
    type: 'top_movers',
    cells,
    facts: {
      movers: top.map((r) => ({ member: r.member, change: round(r.change), contribution: total === 0 ? null : round(r.change / total) })),
    },
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Latest point vs a robust baseline (median + MAD) of the earlier points. */
export function outlier({ series, label = 'value' }, guards = GUARDS) {
  const pts = (series ?? []).filter((p) => Number.isFinite(p.value));
  if (pts.length < guards.minOutlierPoints + 1) return null;
  const last = pts[pts.length - 1];
  const base = pts.slice(0, -1).map((p) => p.value);
  const med = median(base);
  const mad = median(base.map((v) => Math.abs(v - med)));
  if (mad === 0) return null;
  const z = (0.6745 * (last.value - med)) / mad;
  if (Math.abs(z) < guards.outlierK) return null;
  return {
    type: 'outlier',
    cells: { observed: { label: `${label} ${last.period}`, value: last.value }, baseline: { label: `${label} baseline median`, value: med } },
    facts: { period: last.period, score: round(z, 2), direction: z > 0 ? 'above' : 'below', points: base.length },
  };
}

export default { periodChange, topMovers, outlier, GUARDS };
