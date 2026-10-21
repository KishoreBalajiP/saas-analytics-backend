/**
 * Cron next-run calculator with IANA time zone support (dependency-free).
 *
 * WHY IT EXISTS
 *   Scheduled reports and alerts need to project "when does this run next?".
 *   A schedule such as `0 8 * * 1` means 08:00 on Mondays in the workspace's
 *   time zone, not on the server's clock, so the projection walks wall-clock
 *   days in that zone and converts each matching wall time to a UTC instant.
 *
 * SUPPORTED SYNTAX (per field: minute hour day-of-month month day-of-week)
 *   - `*`                 every value
 *   - `*\/n`               step of n from the field minimum
 *   - `a`                 single value
 *   - `a-b`               inclusive range
 *   - `a-b/n`             stepped inclusive range
 *   - `a/n`               from a to the field maximum, step n
 *   - `a,b,c`             list of values/ranges
 *   Day-of-week accepts 0-7 (0 and 7 are Sunday). When both day-of-month and
 *   day-of-week are restricted, a day matches when EITHER matches (POSIX).
 *
 * TIME ZONES
 *   `nextCronDate(expr, from, timeZone)` projects in `timeZone` (default UTC).
 *   Wall times skipped by a DST jump do not fire that day; repeated wall
 *   times fire once, at their first occurrence.
 */

import { DEFAULT_TIMEZONE, isValidTimeZone, normalizeTimeZone, zonedParts, zonedTimeToUtc, addCalendarDays, calendarWeekday } from './timezone.js';

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
];

/** How far ahead (in days) a projection searches before giving up. */
const SEARCH_DAYS = 366 * 5;

function parseNumber(value, field, raw) {
  if (!/^\d+$/.test(String(value))) throw new Error(`Invalid ${field.name} value "${raw}"`);
  const n = Number(value);
  if (n < field.min || n > field.max) {
    throw new Error(`${field.name} value ${n} is out of range ${field.min}-${field.max}`);
  }
  return n;
}

/** Expand one cron field into the sorted list of values it matches. */
function expandField(raw, field) {
  const text = String(raw).trim();
  if (!text) throw new Error(`Empty ${field.name} field`);
  const values = new Set();
  for (const part of text.split(',')) {
    if (!part) throw new Error(`Invalid ${field.name} list "${text}"`);
    const [rangeText, stepText, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`Invalid ${field.name} step "${part}"`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new Error(`Invalid ${field.name} step "${part}"`);
      step = Number(stepText);
    }
    let lo;
    let hi;
    if (rangeText === '*') {
      lo = field.min;
      hi = field.max;
    } else if (rangeText.includes('-')) {
      const [loText, hiText, more] = rangeText.split('-');
      if (more !== undefined) throw new Error(`Invalid ${field.name} range "${part}"`);
      lo = parseNumber(loText, field, part);
      hi = parseNumber(hiText, field, part);
      if (lo > hi) throw new Error(`Invalid ${field.name} range "${part}"`);
    } else {
      lo = parseNumber(rangeText, field, part);
      hi = stepText !== undefined ? field.max : lo;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/**
 * Parse a 5-field cron expression once into match sets.
 * @throws {Error} when the expression is malformed or out of range.
 */
export function parseCron(expr) {
  const fields = String(expr ?? '').trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === '') throw new Error(`Cron expression must have 5 fields: ${expr}`);
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields.map((f, i) => expandField(f, FIELDS[i]));
  if (daysOfWeek.has(7)) daysOfWeek.add(0);
  return {
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

function dayMatches(spec, date) {
  if (!spec.months.has(date.month)) return false;
  const dom = spec.daysOfMonth.has(date.day);
  const dow = spec.daysOfWeek.has(calendarWeekday(date));
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  return dom && dow;
}

/**
 * Return the first instant strictly after `from` at which the cron
 * expression fires in `timeZone`, or `null` when it never fires within the
 * search horizon (e.g. `0 0 31 2 *`).
 *
 * @param {string} expr - 5-field cron expression.
 * @param {Date} [from=new Date()]
 * @param {string} [timeZone='UTC'] - IANA time zone the expression is read in.
 * @returns {Date|null}
 * @throws {Error} on a malformed expression or an unknown time zone.
 */
export function nextCronDate(expr, from = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const spec = parseCron(expr);
  if (timeZone !== undefined && timeZone !== null && timeZone !== '' && !isValidTimeZone(timeZone)) {
    throw new Error(`Unknown time zone "${timeZone}"`);
  }
  const tz = normalizeTimeZone(timeZone);
  const start = zonedParts(from, tz);
  const startDay = { year: start.year, month: start.month, day: start.day };
  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    const date = addCalendarDays(startDay, offset);
    if (!dayMatches(spec, date)) continue;
    for (const hour of spec.hours) {
      if (offset === 0 && hour < start.hour) continue;
      for (const minute of spec.minutes) {
        if (offset === 0 && hour === start.hour && minute < start.minute) continue;
        const instant = zonedTimeToUtc({ ...date, hour, minute }, tz);
        if (instant.getTime() <= from.getTime()) continue;
        // Skip wall times that do not exist on this day (DST gap).
        const shown = zonedParts(instant, tz);
        if (shown.day !== date.day || shown.hour !== hour || shown.minute !== minute) continue;
        return instant;
      }
    }
  }
  return null;
}

/**
 * Throw a 400-style error when a cron expression cannot be scheduled: a
 * malformed expression, an unknown time zone, or one that never fires.
 * Services call this when a schedule is saved, so invalid expressions are
 * rejected up front instead of failing (and re-firing) at run time.
 *
 * @param {string} expr
 * @param {Function} toError - (message) => Error, e.g. ApiError.badRequest
 * @param {string} [timeZone]
 */
export function assertValidCron(expr, toError = (m) => new Error(m), timeZone = DEFAULT_TIMEZONE) {
  let next;
  try {
    next = nextCronDate(expr, new Date(), timeZone);
  } catch (err) {
    throw toError(`Invalid cron expression "${expr}": ${err.message}`);
  }
  if (!next) throw toError(`Invalid cron expression "${expr}": it never runs`);
}

export default { nextCronDate, parseCron, assertValidCron };
