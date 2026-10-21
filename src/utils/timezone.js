/**
 * Time zone helpers (dependency-free, IANA names via `Intl`).
 *
 * WHY IT EXISTS
 *   Business questions ("today", "last month", "every Monday at 08:00") are
 *   asked in the workspace's time zone, not the server's. These helpers turn
 *   wall-clock dates in an IANA zone into UTC instants and back, so date
 *   presets and cron projections never depend on the host's local time.
 *
 * RESPONSIBILITY
 *   - isValidTimeZone / normalizeTimeZone - validate and canonicalise names.
 *   - zonedParts(date, tz)                - wall-clock fields of an instant.
 *   - zonedTimeToUtc(parts, tz)           - instant of a wall-clock time.
 *   - addCalendarDays / startOf* helpers  - calendar arithmetic on {y,m,d}.
 *
 * CODING GUIDELINES
 *   - Never use Date's local getters here: they read the host time zone.
 *   - Calendar dates are plain `{ year, month, day }` objects (month 1-12).
 */

export const DEFAULT_TIMEZONE = 'UTC';

const formatterCache = new Map();

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** True when `value` is an IANA time zone name the runtime understands. */
export function isValidTimeZone(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}

let knownZones = null;
function zoneList() {
  if (!knownZones) {
    try {
      knownZones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    } catch {
      knownZones = [];
    }
  }
  return knownZones;
}

/** Properly-cased IANA spelling, e.g. `Asia/Kolkata`, `UTC`, `Etc/GMT+5`. */
const CASED_ZONE_RE = /^[A-Z][A-Za-z0-9_+-]*(\/[A-Z][A-Za-z0-9_+-]*)*$/;

/**
 * Canonical spelling of a time zone name, or `fallback` when the value is
 * missing or invalid. A correctly-cased name is kept as written (so
 * `Asia/Kolkata` is not rewritten to the ICU alias `Asia/Calcutta`); other
 * casings are mapped to a known spelling (`utc` -> `UTC`). The result is
 * always a name MongoDB's date operators accept.
 */
export function normalizeTimeZone(value, fallback = DEFAULT_TIMEZONE) {
  if (!isValidTimeZone(value)) return fallback;
  const trimmed = value.trim();
  if (CASED_ZONE_RE.test(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  const known = zoneList().find((zone) => zone.toLowerCase() === lower);
  if (known) return known;
  return new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Wall-clock fields of `date` in `timeZone`.
 * @returns {{ year, month, day, hour, minute, second, weekday }} month 1-12, weekday 0 (Sun) - 6.
 */
export function zonedParts(date, timeZone = DEFAULT_TIMEZONE) {
  const out = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    if (part.type === 'weekday') out.weekday = WEEKDAYS[part.value];
    else if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
    weekday: out.weekday,
  };
}

/** Offset of `timeZone` from UTC at `instantMs`, in milliseconds (east positive). */
function offsetAt(instantMs, timeZone) {
  const p = zonedParts(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The UTC instant at which the wall clock in `timeZone` shows the given
 * time. Wall times skipped by a DST jump resolve to the instant just after
 * the jump; repeated wall times resolve to their first occurrence.
 */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 }, timeZone = DEFAULT_TIMEZONE) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const firstOffset = offsetAt(guess, timeZone);
  const candidate = guess - firstOffset;
  const secondOffset = offsetAt(candidate, timeZone);
  if (secondOffset === firstOffset) return new Date(candidate);
  // Near a DST transition the two offsets differ. A candidate is valid when
  // it shows the requested wall time; with two valid ones (clocks went back)
  // take the first occurrence. With none (clocks jumped forward over this
  // wall time) take the later candidate, i.e. shift forward by the gap.
  const candidates = [guess - firstOffset, guess - secondOffset];
  const shows = (t) => {
    const p = zonedParts(new Date(t), timeZone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  };
  const valid = candidates.filter(shows);
  return new Date(valid.length ? Math.min(...valid) : Math.max(...candidates));
}

/** `{year, month, day}` shifted by `days` calendar days. */
export function addCalendarDays({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** `{year, month, day: 1}` shifted by `months` calendar months. */
export function addCalendarMonths({ year, month }, months) {
  const d = new Date(Date.UTC(year, month - 1 + months, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: 1 };
}

/** Day of week (0 = Sunday) of a calendar date. */
export function calendarWeekday({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Start (00:00 wall time) of a calendar date in `timeZone`, as a UTC instant. */
export function startOfZonedDay(date, timeZone = DEFAULT_TIMEZONE) {
  return zonedTimeToUtc({ year: date.year, month: date.month, day: date.day }, timeZone);
}

export default {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  normalizeTimeZone,
  zonedParts,
  zonedTimeToUtc,
  addCalendarDays,
  addCalendarMonths,
  calendarWeekday,
  startOfZonedDay,
};
