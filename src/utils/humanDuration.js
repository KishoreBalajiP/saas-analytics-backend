/**
 * Human-readable durations for user-facing copy (emails, messages).
 *
 * WHY IT EXISTS
 *   Link lifetimes are configurable (auth.15). Emails must state the real
 *   lifetime instead of a hard-coded "15 minutes".
 */

const UNITS = [
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

/**
 * Describe a duration in the largest whole unit that fits exactly, falling
 * back to rounded minutes (e.g. 3600000 -> "1 hour", 259200000 -> "3 days").
 *
 * @param {number} ms
 * @returns {string}
 */
export function describeDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return 'a short time';
  for (const [unit, size] of UNITS) {
    if (value >= size && value % size === 0) {
      const n = value / size;
      return `${n} ${unit}${n === 1 ? '' : 's'}`;
    }
  }
  const minutes = Math.max(1, Math.round(value / 60000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export default { describeDuration };
