/**
 * Injectable clock.
 *
 * WHY IT EXISTS
 *   Relative date presets ("today", "last_month") and schedule projections
 *   depend on the current time. Reading it through this module lets tests
 *   pin "now" to a fixed instant without faking global timers.
 *
 * USAGE
 *   import clock from '../utils/clock.js';
 *   const now = clock.now();
 *
 *   // tests
 *   clock.set(new Date('2026-03-15T10:00:00Z'));
 *   clock.reset();
 */

let fixed = null;

export const clock = {
  /** Current instant (a new Date each call). */
  now() {
    return fixed ? new Date(fixed.getTime()) : new Date();
  },
  /** Pin the clock to `date` (tests only). */
  set(date) {
    fixed = date ? new Date(date) : null;
  },
  /** Return to the real clock. */
  reset() {
    fixed = null;
  },
};

export default clock;
