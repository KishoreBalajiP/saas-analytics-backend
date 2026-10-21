/**
 * Unit tests for `utils/timezone.js` and the time zone aware cron projection
 * in `utils/cron.js` (roadmap 1.2: schedules run in the workspace time zone).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTimeZone,
  normalizeTimeZone,
  zonedParts,
  zonedTimeToUtc,
  addCalendarDays,
  addCalendarMonths,
} from '../../src/utils/timezone.js';
import { nextCronDate, assertValidCron, parseCron } from '../../src/utils/cron.js';

const iso = (d) => d.toISOString();

test('time zone names are validated and canonicalised without renaming valid spellings', () => {
  assert.equal(isValidTimeZone('Asia/Kolkata'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Mars/Olympus_Mons'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(42), false);
  assert.equal(normalizeTimeZone('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(normalizeTimeZone('utc'), 'UTC');
  assert.equal(normalizeTimeZone('america/new_york'), 'America/New_York');
  assert.equal(normalizeTimeZone('nope/nope'), 'UTC', 'invalid names fall back');
  assert.equal(normalizeTimeZone(undefined, 'Europe/Berlin'), 'Europe/Berlin');
});

test('wall-clock conversion in a zone, including DST gaps and overlaps', () => {
  assert.equal(iso(zonedTimeToUtc({ year: 2026, month: 1, day: 1 }, 'Asia/Kolkata')), '2025-12-31T18:30:00.000Z');
  assert.equal(iso(zonedTimeToUtc({ year: 2026, month: 7, day: 1, hour: 9 }, 'America/New_York')), '2026-07-01T13:00:00.000Z');
  // 02:30 does not exist on 2026-03-08 in New York: shifted past the gap.
  assert.equal(iso(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York')), '2026-03-08T07:30:00.000Z');
  // 01:30 happens twice on 2026-11-01: the first occurrence (EDT) wins.
  assert.equal(iso(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York')), '2026-11-01T05:30:00.000Z');
  const p = zonedParts(new Date('2026-01-01T00:00:00Z'), 'America/Los_Angeles');
  assert.deepEqual({ y: p.year, m: p.month, d: p.day, h: p.hour, w: p.weekday }, { y: 2025, m: 12, d: 31, h: 16, w: 3 });
  assert.deepEqual(addCalendarDays({ year: 2024, month: 2, day: 28 }, 1), { year: 2024, month: 2, day: 29 });
  assert.deepEqual(addCalendarMonths({ year: 2026, month: 1 }, -1), { year: 2025, month: 12, day: 1 });
});

test('cron next run is projected in the given time zone', () => {
  const from = new Date('2026-10-20T00:00:00Z');
  // 08:00 in Kolkata (UTC+05:30) is 02:30 UTC.
  assert.equal(iso(nextCronDate('0 8 * * *', from, 'Asia/Kolkata')), '2026-10-20T02:30:00.000Z');
  // Same expression in UTC.
  assert.equal(iso(nextCronDate('0 8 * * *', from, 'UTC')), '2026-10-20T08:00:00.000Z');
  assert.equal(iso(nextCronDate('0 8 * * *', from)), '2026-10-20T08:00:00.000Z', 'UTC by default');
  // Monday 09:00 in New York, before and after the DST change.
  assert.equal(iso(nextCronDate('0 9 * * 1', new Date('2026-10-27T00:00:00Z'), 'America/New_York')), '2026-11-02T14:00:00.000Z');
  assert.equal(iso(nextCronDate('0 9 * * 1', new Date('2026-10-20T00:00:00Z'), 'America/New_York')), '2026-10-26T13:00:00.000Z');
  // Strictly after `from`.
  assert.equal(iso(nextCronDate('30 2 * * *', new Date('2026-10-20T02:30:00Z'), 'UTC')), '2026-10-21T02:30:00.000Z');
});

test('cron skips wall times that do not exist and fires once on repeated hours', () => {
  // 02:30 does not exist on 2026-03-08 in New York: the next run is the 9th.
  assert.equal(iso(nextCronDate('30 2 * * *', new Date('2026-03-08T00:00:00Z'), 'America/New_York')), '2026-03-09T06:30:00.000Z');
  const first = nextCronDate('30 1 * * *', new Date('2026-11-01T00:00:00Z'), 'America/New_York');
  assert.equal(iso(first), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(nextCronDate('30 1 * * *', first, 'America/New_York')), '2026-11-02T06:30:00.000Z');
});

test('cron syntax: ranges, steps, lists, Sunday as 7, POSIX day matching', () => {
  const from = new Date('2026-10-20T00:00:00Z'); // a Tuesday
  assert.equal(iso(nextCronDate('*/15 * * * *', from)), '2026-10-20T00:15:00.000Z');
  assert.equal(iso(nextCronDate('0 9-17/4 * * *', from)), '2026-10-20T09:00:00.000Z');
  assert.equal(iso(nextCronDate('0 0 * * 7', from)), '2026-10-25T00:00:00.000Z');
  assert.equal(iso(nextCronDate('0 0 1,15 * *', from)), '2026-11-01T00:00:00.000Z');
  // dom AND dow restricted -> either matches (the 21st is a Wednesday, the 23rd a Friday).
  assert.equal(iso(nextCronDate('0 0 23 * 3', from)), '2026-10-21T00:00:00.000Z');
  assert.equal(iso(nextCronDate('0 0 29 2 *', from)), '2028-02-29T00:00:00.000Z', 'leap day within the horizon');
  assert.equal(nextCronDate('0 0 31 2 *', from), null, 'never fires');
  assert.deepEqual(parseCron('5/20 * * * *').minutes, [5, 25, 45]);
});

test('invalid cron expressions and time zones are rejected up front', () => {
  for (const bad of ['', '* * * *', '61 * * * *', '* 24 * * *', '* * 0 * *', 'a * * * *', '*/0 * * * *', '5-1 * * * *']) {
    assert.throws(() => assertValidCron(bad, (m) => new Error(m)), /Invalid cron expression/, bad);
  }
  assert.throws(() => assertValidCron('0 0 31 2 *', (m) => new Error(m)), /never runs/);
  assert.throws(() => nextCronDate('0 8 * * *', new Date(), 'Mars/Base'), /Unknown time zone/);
  assert.doesNotThrow(() => assertValidCron('0 8 * * 1-5', (m) => new Error(m), 'Europe/Berlin'));
});
