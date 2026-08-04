/**
 * Shared test utilities - assertions, environment setup, and helpers.
 *
 * WHY IT EXISTS
 *   Centralises test boilerplate so individual test files stay focused on
 *   the unit under test. Imports stay short and the platform has one place
 *   to add cross-cutting test behaviour.
 */

import { after, before } from 'node:test';
import { startMongo, stopMongo, resetMongo } from './mongo.js';

/**
 * Register the standard "before all / after all / before each" hooks used
 * by integration tests. The function returns nothing; tests just call it
 * at the top level.
 *
 * ```js
 *   import { useMongo } from './helpers/index.js';
 *   useMongo();
 * ```
 */
export function useMongo() {
  before(async () => { await startMongo(); });
  after(async () => { await stopMongo(); });
  before(async () => { await resetMongo(); });
}

/**
 * Tiny helper: assert a value is truthy with a custom message.
 *
 * @param {*} actual
 * @param {string} [message]
 */
export function assertOk(actual, message) {
  if (!actual) {
    throw new Error(message ?? 'Expected truthy value');
  }
}

/**
 * Assert two values are deeply equal (structural).
 *
 * @param {*} actual
 * @param {*} expected
 * @param {string} [message]
 */
export function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message ?? 'values differ'}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

/**
 * Sleep helper for time-sensitive tests.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { startMongo, stopMongo, resetMongo } from './mongo.js';
export { factories } from './factories.js';
export * from './auth.js';
