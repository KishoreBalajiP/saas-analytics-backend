/**
 * Security detection helpers (roadmap 2.6): sliding windows, network
 * ranges, threshold overrides and the rule catalogue contract. Pure unit
 * tests (no database).
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { slidingWindow, ipRange, topValues, utcDay } from '../../src/services/securityDetection/util.js';
import { applyOverrides, checkParam, int, strings, timeZone } from '../../src/services/securityDetection/params.js';
import { RULES, getRule } from '../../src/services/securityDetection/rules/index.js';
import { insideChangeWindow } from '../../src/services/securityDetection/rules/privilege.js';
import { ALERT_SEVERITIES } from '../../src/models/SecurityAlert.js';

const base = Date.parse('2026-10-20T12:00:00.000Z');
const ev = (minute, extra = {}) => ({ occurredAt: new Date(base + minute * 60000), ...extra });

describe('slidingWindow', () => {
  test('finds the densest qualifying window and ignores sparser ones', () => {
    const events = [ev(0), ev(1), ev(2), ev(30), ev(31), ev(32), ev(33)];
    const best = slidingWindow(events, { windowMs: 5 * 60000, qualifies: (w) => w.count >= 3 });
    assert.equal(best.count, 4);
    assert.deepEqual(best.start, new Date(base + 30 * 60000));
    assert.deepEqual(best.end, new Date(base + 33 * 60000));
  });

  test('does not qualify below the threshold', () => {
    const events = [ev(0), ev(10), ev(20)];
    assert.equal(slidingWindow(events, { windowMs: 5 * 60000, qualifies: (w) => w.count >= 2 }), null);
  });

  test('only windows ending after the watermark are reported (no reprocessing)', () => {
    const events = [ev(0), ev(1), ev(2)];
    const watermark = new Date(base + 2 * 60000);
    assert.equal(slidingWindow(events, { windowMs: 10 * 60000, after: watermark, qualifies: (w) => w.count >= 3 }), null);
    const later = [...events, ev(3)];
    const best = slidingWindow(later, { windowMs: 10 * 60000, after: watermark, qualifies: (w) => w.count >= 3 });
    assert.equal(best.count, 4);
  });

  test('counts distinct keys and weighted sums inside the window', () => {
    const events = [
      ev(0, { k: 'a', n: 5, e: 1 }), ev(1, { k: 'b', n: 5, e: 4 }), ev(2, { k: 'a', n: 5, e: 5 }), ev(20, { k: 'c', n: 1, e: 0 }),
    ];
    const best = slidingWindow(events, {
      windowMs: 5 * 60000,
      weight: (e) => e.n,
      distinct: (e) => e.k,
      sums: { errors: (e) => e.e },
      qualifies: (w) => w.count >= 15 && w.distinct >= 2 && w.sums.errors >= 10,
    });
    assert.equal(best.count, 15);
    assert.equal(best.distinct, 2);
    assert.equal(best.sums.errors, 10);
  });

  test('events sharing a timestamp are never split across windows', () => {
    const events = [ev(0), ev(0), ev(0)];
    const best = slidingWindow(events, { windowMs: 60000, qualifies: (w) => w.count >= 3 });
    assert.equal(best.count, 3);
  });
});

describe('ipRange', () => {
  test('reduces IPv4, IPv4-mapped and IPv6 addresses to their network range', () => {
    assert.equal(ipRange('203.0.113.77'), '203.0.113.0/24');
    assert.equal(ipRange('::ffff:198.51.100.9'), '198.51.100.0/24');
    assert.equal(ipRange('2001:db8:abcd:12::1'), '2001:db8:abcd::/48');
    assert.equal(ipRange('2001:0db8:0001:0000:0000:0000:0000:0001'), '2001:db8:1::/48');
    assert.equal(ipRange('::1'), '0:0:0::/48');
  });

  test('rejects anything that is not an address', () => {
    for (const value of [null, '', 'localhost', '999.1.1.1', '1.2.3', 'abc:xyz']) {
      assert.equal(ipRange(value), null, String(value));
    }
  });
});

describe('threshold overrides', () => {
  const rule = { params: { minFailures: int(2, 100), names: strings({ maxItems: 2 }), zone: timeZone() } };

  test('valid overrides apply; unknown, wrong-typed and out-of-range ones are ignored and reported', () => {
    const { config, ignored } = applyOverrides(rule, { enabled: true, minFailures: 20, names: ['a'], zone: 'UTC' }, {
      minFailures: 5,
      enabled: false,
      names: ['x', 'y', 'z'],
      zone: 'Mars/Olympus',
      bogus: 1,
    }, 'setting');
    assert.equal(config.minFailures, 5);
    assert.equal(config.enabled, false);
    assert.deepEqual(config.names, ['a']);
    assert.equal(config.zone, 'UTC');
    assert.deepEqual(ignored.map((i) => i.param).sort(), ['bogus', 'names', 'zone']);
  });

  test('a string is never accepted for a numeric threshold', () => {
    assert.equal(checkParam(int(1, 10), '5').ok, false);
    assert.equal(checkParam(int(1, 10), 0).ok, false);
    assert.equal(checkParam(int(1, 10), 2.5).ok, false);
    assert.equal(checkParam(int(1, 10), 10).ok, true);
  });

  test('non-object overrides are ignored', () => {
    const { config, ignored } = applyOverrides(rule, { minFailures: 20 }, 'nope', 'env');
    assert.equal(config.minFailures, 20);
    assert.equal(ignored[0].param, '*');
  });
});

describe('rule catalogue', () => {
  test('every rule is versioned, unique and declares defaults matching its params', () => {
    const ids = new Set();
    for (const rule of RULES) {
      assert.match(rule.id, /^[a-z_]+\.[a-z_]+$/, rule.id);
      assert.ok(!ids.has(rule.id), `duplicate ${rule.id}`);
      ids.add(rule.id);
      assert.ok(Number.isInteger(rule.version) && rule.version >= 1, `${rule.id} version`);
      assert.ok(ALERT_SEVERITIES.includes(rule.severity), `${rule.id} severity`);
      assert.equal(typeof rule.evaluate, 'function');
      assert.equal(rule.defaults.enabled, true, `${rule.id} enabled by default`);
      for (const [param, value] of Object.entries(rule.defaults)) {
        if (param === 'enabled') continue;
        const spec = rule.params[param];
        assert.ok(spec, `${rule.id}.${param} has a declared type`);
        assert.equal(checkParam(spec, Array.isArray(value) ? [...value] : value).ok, true, `${rule.id}.${param} default is valid`);
      }
    }
    assert.equal(RULES.length, 15);
    assert.equal(getRule('auth.credential_stuffing').severity, 'high');
    assert.equal(getRule('nope'), undefined);
  });

  test('change window evaluation honours the configured time zone', () => {
    const config = { changeWindowTimeZone: 'Asia/Kolkata', changeWindowDays: [1, 2, 3, 4, 5], changeWindowStartHour: 9, changeWindowEndHour: 18 };
    // Tuesday 2026-10-20 05:00 UTC = 10:30 IST (inside), 14:00 UTC = 19:30 IST (outside).
    assert.equal(insideChangeWindow(new Date('2026-10-20T05:00:00Z'), config), true);
    assert.equal(insideChangeWindow(new Date('2026-10-20T14:00:00Z'), config), false);
    // Saturday.
    assert.equal(insideChangeWindow(new Date('2026-10-24T05:00:00Z'), config), false);
  });

  test('topValues and utcDay', () => {
    assert.deepEqual(topValues(['a', 'b', 'a', null]), [{ value: 'a', count: 2 }, { value: 'b', count: 1 }]);
    assert.equal(utcDay(new Date('2026-10-20T23:59:59Z')), '2026-10-20');
  });
});
