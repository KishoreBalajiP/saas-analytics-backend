/**
 * Shared helpers for the security detection rules (roadmap 2.6).
 *
 * Pure functions only (no I/O), so every rule's windowing is unit-testable
 * and identical across rules:
 *   - `slidingWindow`  best qualifying window over a time-ordered stream,
 *                      considering only windows that END at an event after
 *                      the watermark (incremental evaluation: events at or
 *                      before the watermark were evaluated by earlier ticks)
 *   - `ipRange`        an address reduced to its /24 (IPv4) or /48 (IPv6)
 *   - `groupBy`, `ref`, `topValues`, `utcDay`, `pairKey`
 */

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Maximum evidence references one detection carries. */
export const MAX_REFS = 20;

/** Group items by a key function (null / '' keys are skipped). */
export function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key === null || key === undefined || key === '') continue;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/**
 * Find the best qualifying sliding window over `events` (sorted oldest
 * first). A window is the events in (end - windowMs, end] for an `end` that
 * is the time of an event strictly after `after`.
 *
 * @param {Array} events
 * @param {Object} options
 * @param {number} options.windowMs
 * @param {Date|null} [options.after] - watermark; windows must end after it.
 * @param {(e) => Date} [options.time] - event time (default `occurredAt`).
 * @param {(e) => number} [options.weight] - event weight (default 1).
 * @param {(e) => (string|null)} [options.distinct] - key counted distinctly.
 * @param {Object<string, (e) => number>} [options.sums] - extra per-window sums.
 * @param {(w: { count: number, distinct: number, sums: Object }) => boolean} options.qualifies
 * @returns {{ count: number, distinct: number, sums: Object, start: Date, end: Date, events: Array }|null}
 *   the qualifying window with the highest count, or null.
 */
export function slidingWindow(events, {
  windowMs,
  after = null,
  time = (e) => e.occurredAt,
  weight = () => 1,
  distinct = null,
  sums = {},
  qualifies,
}) {
  const afterMs = after ? new Date(after).getTime() : -Infinity;
  const distinctCounts = new Map();
  const sumNames = Object.keys(sums);
  const totals = Object.fromEntries(sumNames.map((name) => [name, 0]));
  let best = null;
  let count = 0;
  let start = 0;
  for (let end = 0; end < events.length; end += 1) {
    const endMs = new Date(time(events[end])).getTime();
    count += weight(events[end]);
    for (const name of sumNames) totals[name] += Number(sums[name](events[end])) || 0;
    if (distinct) {
      const key = distinct(events[end]);
      if (key) distinctCounts.set(key, (distinctCounts.get(key) ?? 0) + 1);
    }
    while (start < end && new Date(time(events[start])).getTime() <= endMs - windowMs) {
      count -= weight(events[start]);
      for (const name of sumNames) totals[name] -= Number(sums[name](events[start])) || 0;
      if (distinct) {
        const key = distinct(events[start]);
        if (key) {
          const left = (distinctCounts.get(key) ?? 1) - 1;
          if (left <= 0) distinctCounts.delete(key);
          else distinctCounts.set(key, left);
        }
      }
      start += 1;
    }
    if (endMs <= afterMs) continue;
    // Only report a window once it is complete up to the last event sharing
    // this timestamp, so equal timestamps are never split.
    if (end + 1 < events.length && new Date(time(events[end + 1])).getTime() === endMs) continue;
    const window = { count, distinct: distinctCounts.size, sums: { ...totals } };
    if (!qualifies(window)) continue;
    if (!best || count > best.count) {
      best = {
        count,
        distinct: distinctCounts.size,
        sums: window.sums,
        start: new Date(time(events[start])),
        end: new Date(endMs),
        from: start,
        to: end,
      };
    }
  }
  if (!best) return null;
  return {
    count: best.count,
    distinct: best.distinct,
    sums: best.sums,
    start: best.start,
    end: best.end,
    events: events.slice(best.from, best.to + 1),
  };
}

/**
 * Reduce an address to a network range: IPv4 /24 (`203.0.113.0/24`), IPv6
 * /48 (`2001:db8:1::/48`); IPv4-mapped IPv6 is treated as IPv4. Returns
 * null for anything that is not an address.
 */
export function ipRange(ip) {
  if (!ip || typeof ip !== 'string') return null;
  let value = ip.trim();
  if (value.startsWith('::ffff:') && value.includes('.')) value = value.slice(7);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const parts = v4.slice(1, 4).map(Number);
    if (parts.some((part) => part > 255) || Number(v4[4]) > 255) return null;
    return `${parts.join('.')}.0/24`;
  }
  if (!/^[0-9a-fA-F:]+$/.test(value) || !value.includes(':')) return null;
  const [head] = value.split('::');
  const groups = head ? head.split(':') : [];
  const expanded = [...groups];
  if (!value.includes('::') && groups.length !== 8) return null;
  while (expanded.length < 3) expanded.push('0');
  const prefix = expanded.slice(0, 3).map((group) => (group || '0').toLowerCase().replace(/^0+(?=.)/, ''));
  return `${prefix.join(':')}::/48`;
}

/** Build an evidence reference (labels are truncated). */
export function ref(source, id, at, label = '') {
  return {
    source,
    id: id === null || id === undefined ? null : String(id),
    at: at ? new Date(at) : null,
    label: String(label ?? '').slice(0, 300),
  };
}

/** The newest `max` references (evidence lists stay small). */
export function lastRefs(refs, max = MAX_REFS) {
  return refs.length > max ? refs.slice(refs.length - max) : refs;
}

/** Most frequent values with their counts (`[{ value, count }]`). */
export function topValues(values, max = 10) {
  const counts = new Map();
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, max)
    .map(([value, count]) => ({ value, count }));
}

/** Distinct values, capped. */
export function distinctValues(values, max = 20) {
  return [...new Set(values.filter((v) => v !== null && v !== undefined && v !== ''))].slice(0, max);
}

/** UTC calendar day `YYYY-MM-DD` of an instant. */
export function utcDay(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/** Start of the UTC day containing `at`. */
export function utcDayStart(at) {
  const d = new Date(at);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Audit/security-event metadata (real `metadata`, or `after` from older writers). */
export function eventMetadata(row) {
  const value = row?.metadata ?? row?.after ?? null;
  return value && typeof value === 'object' ? value : {};
}

/** Average events per window over a baseline period. */
export function baselinePerWindow(total, { baselineMs, windowMs }) {
  if (!baselineMs || baselineMs <= 0) return 0;
  return (Number(total) || 0) / (baselineMs / windowMs);
}
