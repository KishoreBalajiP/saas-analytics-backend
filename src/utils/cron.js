/**
 * Minimal cron next-run calculator (UTC, dependency-free).
 *
 * WHY IT EXISTS
 *   Scheduled reports and alerts need to project "when does this run next?"
 *   without pulling in a cron library. The engine iterates minute-by-minute
 *   from `from` (capped at one year ahead) and returns the first instant that
 *   satisfies a standard 5-field cron expression.
 *
 * SUPPORTED SYNTAX (per field)
 *   - `*`                 every value
 *   - `*\/n`               step of n from the field minimum
 *   - `a`                 single value
 *   - `a-b`               inclusive range
 *   - `a-b/n`             stepped inclusive range
 *   - `a,b,c`             list of values/ranges
 *
 * Timezone is stored on the schedule but next-run projection is always UTC.
 */

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
];

function parseInt10(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : NaN;
}

function parseField(field, { min, max }) {
  const raw = String(field).trim();
  if (raw === '*') return () => true;
  if (raw.startsWith('*/')) {
    const step = parseInt10(raw.slice(2));
    if (!step || step < 1) throw new Error(`Invalid cron step: ${raw}`);
    return (v) => (v - min) % step === 0;
  }
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  const tests = [];
  for (const part of parts) {
    if (part.includes('-')) {
      const [range, stepStr] = part.split('/');
      const [loStr, hiStr] = range.split('-');
      const lo = parseInt10(loStr);
      const hi = parseInt10(hiStr);
      const step = stepStr ? parseInt10(stepStr) : 1;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || step < 1) {
        throw new Error(`Invalid cron range: ${part}`);
      }
      tests.push((v) => v >= lo && v <= hi && (v - lo) % step === 0);
    } else if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt10(stepStr);
      if (!step || step < 1) throw new Error(`Invalid cron step: ${part}`);
      if (range === '*') {
        tests.push((v) => (v - min) % step === 0);
      } else {
        const base = parseInt10(range);
        tests.push((v) => v === base);
      }
    } else {
      const n = parseInt10(part);
      if (!Number.isFinite(n)) throw new Error(`Invalid cron value: ${part}`);
      tests.push((v) => v === n);
    }
  }
  return (v) => tests.some((t) => t(v));
}

function matches(expr, date) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron expression must have 5 fields: ${expr}`);
  const [min, hr, dom, mon, dow] = fields.map((f, i) => parseField(f, FIELDS[i]));
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dayOfWeek = date.getUTCDay();

  const domMatch = dom(dayOfMonth);
  const dowMatch = dow(dayOfWeek);
  const domRestricted = String(fields[2]).trim() !== '*';
  const dowRestricted = String(fields[4]).trim() !== '*';
  const dayMatch = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;

  return min(minute) && hr(hour) && mon(month) && dayMatch;
}

/**
 * Return the next Date (UTC) strictly after `from` that satisfies the cron
 * expression, or `null` when none is found within a year.
 *
 * @param {string} expr - 5-field cron expression.
 * @param {Date} [from=new Date()]
 * @returns {Date|null}
 */
export function nextCronDate(expr, from = new Date()) {
  let cursor = new Date(from.getTime() + 60 * 1000);
  cursor.setUTCSeconds(0, 0);
  const limit = new Date(cursor.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (cursor <= limit) {
    if (matches(expr, cursor)) return new Date(cursor);
    cursor = new Date(cursor.getTime() + 60 * 1000);
  }
  return null;
}

export default { nextCronDate };
