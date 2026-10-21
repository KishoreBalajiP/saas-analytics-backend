/**
 * Claim checker and causal-language lint (ai-insights).
 *
 * A narrated claim survives only when every number in its text matches a
 * referenced cell, or a difference, ratio or percentage change of two
 * referenced cells, within display rounding. Claims using causal wording
 * are removed unless the narrator labelled them `possible_explanation`
 * and the text says so ("possible", "may").
 */

const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?%?/g;
const CAUSAL_RE = /\b(because|caused|causes|cause of|due to|drove|drives|driven by|led to|leads to|resulted in|as a result of|thanks to|owing to)\b/i;
const HEDGE_RE = /\b(possible|possibly|may|might|could)\b/i;

export function numbersIn(text) {
  return (String(text).match(NUMBER_RE) ?? []).map((raw) => ({
    raw,
    value: Number(raw.replace(/[,%]/g, '')),
    percent: raw.endsWith('%'),
  })).filter((n) => Number.isFinite(n.value));
}

/** Values derivable from the referenced cells (the cells, |differences|, ratios, % changes). */
export function derivable(values) {
  const out = new Set();
  const add = (v) => { if (Number.isFinite(v)) out.add(v); };
  for (const a of values) add(a);
  for (const a of values) {
    for (const b of values) {
      if (a === b) continue;
      add(Math.abs(a - b));
      if (b !== 0) { add(a / b); add(((a - b) / Math.abs(b)) * 100); add(Math.abs(((a - b) / Math.abs(b)) * 100)); add((a / b) * 100); }
    }
  }
  return [...out];
}

/** Does `n` match one of `candidates` at the precision it was written with? */
function matches(n, candidates) {
  const decimals = (n.raw.split('.')[1] ?? '').replace('%', '').length;
  const tol = 0.5 * 10 ** -decimals + 1e-9;
  return candidates.some((c) => Math.abs(Math.abs(c) - Math.abs(n.value)) <= tol);
}

export function isCausal(claim) {
  if (!CAUSAL_RE.test(claim.text ?? '')) return false;
  return !(claim.label === 'possible_explanation' && HEDGE_RE.test(claim.text));
}

/**
 * @param {Array<{ text, cells: string[], label? }>} claims
 * @param {Object<string, { value: number }>} cells
 * @returns {{ kept: object[], removed: Array<{ claim, reason }> }}
 */
export function checkClaims(claims, cells) {
  const kept = [];
  const removed = [];
  for (const claim of claims ?? []) {
    const refs = (claim.cells ?? []).filter((id) => cells[id]);
    if (isCausal(claim)) { removed.push({ claim, reason: 'causal_language' }); continue; }
    const nums = numbersIn(claim.text);
    if (nums.length && !refs.length) { removed.push({ claim, reason: 'no_cells' }); continue; }
    // Numbers in the referenced cell labels (periods, member names) are context, not claims.
    const labelNumbers = refs.flatMap((id) => numbersIn(cells[id].label ?? '').map((n) => n.value));
    const candidates = [...derivable(refs.map((id) => Number(cells[id].value))), ...labelNumbers];
    const bad = nums.find((n) => !matches(n, candidates));
    if (bad) { removed.push({ claim, reason: 'untraceable_number' }); continue; }
    kept.push({ text: String(claim.text).slice(0, 500), cells: refs, label: claim.label ?? 'observation' });
  }
  return { kept, removed };
}

export default { checkClaims, isCausal, numbersIn, derivable };
