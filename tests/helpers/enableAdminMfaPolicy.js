/**
 * Turn the privileged-admin MFA policy ON for one test file (adminauth).
 *
 * The test runner sets `ADMIN_MFA_REQUIRED_TYPES=none` so the general suite
 * can sign platform admins in with a password only. Suites that exercise
 * the policy import this module FIRST (before anything that loads
 * `src/config/env.js`): ES modules evaluate imports in order, so the
 * variable is set before the config is read. Each test file runs in its own
 * process, so other files are unaffected.
 */

process.env.ADMIN_MFA_REQUIRED_TYPES = 'super,platform';
