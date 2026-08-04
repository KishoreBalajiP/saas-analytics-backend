/**
 * Fail-closed stub helpers for architecture-only modules.
 *
 * WHY IT EXISTS
 *   Phase 1.1 defines the contracts for queues, storage and cache but ships no
 *   implementation. These helpers build fail-closed stub objects that still
 *   document the EXACT method surface a future implementation must provide -
 *   so a developer can read the shape from code, and any accidental call
 *   fails loudly instead of silently doing nothing.
 *
 * RESPONSIBILITY
 *   - `createStubDriver(name, methods)` - build an object whose methods all
 *     throw a descriptive "not implemented" error.
 *   - `notImplemented(name, method)` - build that error on demand.
 *
 * HOW TO EXTEND
 *   Only add helpers here that multiple placeholder modules share. If a real
 *   implementation arrives, its module replaces the stub driver entirely.
 */

/**
 * Create a frozen stub object exposing `methods`, each failing closed.
 *
 * @param {string} name - module/driver name used in error messages.
 * @param {string[]} methods - method names of the documented contract.
 * @returns {Object} stub driver whose methods throw when called.
 */
export function createStubDriver(name, methods) {
  const driver = {};
  for (const method of methods) {
    driver[method] = async (..._args) => {
      throw notImplemented(name, method);
    };
  }
  return Object.freeze(driver);
}

/** Build the descriptive "not implemented" error for a module/method. */
export function notImplemented(name, method) {
  return new Error(`${name}.${method} is not implemented yet (Phase 1.1 placeholder)`);
}

/**
 * Build an async thunk that throws the descriptive "not implemented" error.
 * Use this for service / controller placeholder exports so their runtime
 * surface already documents the contract and calling them fails loudly
 * until Phase 2 wires real implementations.
 *
 * Accepts either a fully-qualified name (string) or `(module, method)`.
 * Phase 1.2 service and middleware stubs rely on this helper.
 *
 * @param {string} nameOrModule  fully-qualified name OR module identifier
 * @param {string} [method]      method name when called with two args
 * @returns {Function} async (...args) => throws
 */
export function notImplementedStub(nameOrModule, method) {
  const hasMethod = method !== undefined;
  const fn = async (..._args) => {
    if (hasMethod) throw notImplemented(nameOrModule, method);
    throw new Error(`${nameOrModule} is not implemented yet (Phase 1.2 architecture placeholder)`);
  };
  // Useful when callers want to log or assert the function identity.
  Object.defineProperty(fn, 'name', { value: hasMethod ? method : 'notImplementedStub' });
  return fn;
}
