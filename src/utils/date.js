/**
 * Date/time helpers.
 *
 * WHY IT EXISTS
 *   Keeps time math and formatting in one audited place and enforces UTC as
 *   the canonical timezone for the backend.
 *
 * RESPONSIBILITY
 *   Simple, dependency-free helpers for common date operations.
 *
 * HOW TO EXTEND
 *   Add helpers as new requirements appear (e.g. `startOfDay`, `nextMonth`).
 *   Always compute in UTC and only convert for display in the client.
 */

/** Current time as an ISO-8601 string (canonical backend format). */
export const toISO = (date = new Date()) => date.toISOString();

/** Add `days` to a date, returning a new Date (input untouched). */
export const addDays = (date, days) => new Date(date.getTime() + days * 86_400_000);

/** Add `hours` to a date, returning a new Date. */
export const addHours = (date, hours) => new Date(date.getTime() + hours * 3_600_000);

/** Add `minutes` to a date, returning a new Date. */
export const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60_000);

/** True when the given date is in the past. */
export const isExpired = (date) => new Date(date).getTime() < Date.now();

/** Whole days between two dates (positive when `a` is after `b`). */
export const daysBetween = (a, b) =>
  Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);

/** Format a duration in seconds as a human string, e.g. "1d 02:03:04". */
export function formatUptime(seconds = process.uptime()) {
  const total = Math.floor(seconds);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}
