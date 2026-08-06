/**
 * Password hashing utilities.
 *
 * WHY IT EXISTS
 *   User passwords (and admin passwords, service secrets, refresh-token
 *   hashes) must NEVER be stored in clear text. This module is the ONLY
 *   place the application hashes or verifies credentials, so the algorithm
 *   parameters can be tuned in one place as hardware changes.
 *
 * RESPONSIBILITY
 *   - `hash(plain[, salt])` -> PHC-formatted hash (algorithm encoded in the
 *     output, so stored hashes verify regardless of the current KDF).
 *   - `verify(plain, hash)` -> constant-time comparison.
 *   - `needsRehash(hash)` -> detect hashes produced with weaker parameters.
 *
 * DESIGN CONSTRAINTS
 *   - Default KDF is Argon2id (the OWASP-recommended variant). Parameters are
 *     tuned for ~150-300ms on modern hardware; bump them on CI and benchmark
 *     before changing.
 *   - `PASSWORD_KDF=scrypt` selects the Node built-in scrypt (N=16384, r=8,
 *     p=1, 32-byte key) as a drop-in fallback. The test suite runs in this
 *     mode so tests are portable across machines that lack a working Argon2
 *     native binary. Argon2id remains the production default and is exercised
 *     on CI via `npm run test:argon2`.
 *   - An explicit salt makes the hash deterministic, which is what refresh
 *     tokens rely on for server-side lookup. Only ever pass a salt derived
 *     from the secret itself (see `session.service.hashRefreshToken`); never
 *     reuse a user-controlled or weak salt for passwords.
 *   - Never logs the password or the hash.
 *
 * HOW TO EXTEND
 *   - When migrating to a hardware-backed KDF (e.g. HSM-backed Argon2) only
 *     this module changes; the rest of the codebase uses `hash/verify`.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import env from '../config/env.js';

const scrypt = promisify(scryptCb);

let argon2Module = null;

/**
 * Load the Argon2 native module lazily on first password operation. Deferred
 * so the app can boot even when the native binary is missing or incompatible;
 * only hashing and verification require it. The module is cached after load.
 *
 * @returns {Promise<object>} the argon2 module (the CommonJS default export).
 */
async function loadArgon2() {
  if (!argon2Module) {
    const mod = await import('argon2');
    argon2Module = mod.default ?? mod;
  }
  return argon2Module;
}

/** Argon2id parameters. Keep these conservative but hardware-tunable. */
const ARGON2_OPTIONS = Object.freeze({
  // memoryCost (KiB). 19 MiB is the OWASP 2024 baseline for Argon2id.
  memoryCost: 19 * 1024,
  // timeCost (iterations).
  timeCost: 2,
  // parallelism (lanes / threads).
  parallelism: 1,
});

/** scrypt parameters (only active when `PASSWORD_KDF=scrypt`). */
const SCRYPT_OPTIONS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  keylen: 32,
});

/** Rehash when the encoded hash uses weaker parameters than current. */
const MIN_MEMORY_COST = 19 * 1024;
const MIN_TIME_COST = 2;
const MIN_SCRYPT_N = SCRYPT_OPTIONS.N;

const isScrypt = () => env.security.kdf === 'scrypt';

/**
 * Normalise a caller-supplied salt. Random 16-byte salts are used for
 * passwords; deterministic salts (derived from the secret itself) are used
 * for refresh-token hashes so the same token always maps to the same hash.
 *
 * @param {Buffer|string|undefined} salt - salt; hex string or Buffer.
 * @returns {Buffer} 8-64 byte salt.
 */
function normalizeSalt(salt) {
  if (salt === undefined || salt === null) return randomBytes(16);
  if (typeof salt === 'string') {
    if (!/^[0-9a-fA-F]+$/.test(salt) || salt.length % 2 !== 0) {
      throw new Error('salt string must be hex-encoded');
    }
    return normalizeSalt(Buffer.from(salt, 'hex'));
  }
  if (!Buffer.isBuffer(salt)) {
    throw new Error('salt must be a Buffer or hex string');
  }
  if (salt.length < 8 || salt.length > 64) {
    throw new Error('salt must be between 8 and 64 bytes');
  }
  return salt;
}

/* ------------------------------- public ---------------------------------- */

/**
 * Hash a plaintext password. The returned string contains the algorithm,
 * parameters, salt and digest in a single PHC-formatted value, so the output
 * verifies under any KDF even if the runtime default changes later.
 *
 * @param {string} plain - plaintext password (never logged).
 * @param {Buffer|string} [salt] - optional explicit salt (see normalizeSalt).
 * @returns {Promise<string>} encoded hash.
 * @throws {Error} when `plain` is empty or not a string.
 */
export async function hash(plain, salt) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hash() requires a non-empty string');
  }
  const saltBuf = normalizeSalt(salt);

  if (isScrypt()) {
    const key = await scrypt(plain, saltBuf, SCRYPT_OPTIONS.keylen, {
      N: SCRYPT_OPTIONS.N,
      r: SCRYPT_OPTIONS.r,
      p: SCRYPT_OPTIONS.p,
      maxmem: 128 * 1024 * 1024,
    });
    const params = `N=${SCRYPT_OPTIONS.N},r=${SCRYPT_OPTIONS.r},p=${SCRYPT_OPTIONS.p}`;
    return `$scrypt$${params}$${saltBuf.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
  }

  const argon2 = await loadArgon2();
  return argon2.hash(plain, {
    ...ARGON2_OPTIONS,
    salt: saltBuf,
    type: argon2.argon2id,
  });
}

/**
 * Verify a plaintext password against a stored hash. Dispatches on the
 * algorithm encoded in the hash, so Argon2id hashes still verify when the
 * runtime is in scrypt mode (and vice versa).
 *
 * @param {string} plain - plaintext password.
 * @param {string} encoded - hash produced by `hash()`.
 * @returns {Promise<boolean>} `true` when the password matches.
 * @throws {Error} only when `plain` is empty; an empty / malformed hash is
 *   treated as a verification failure to avoid leaking structural
 *   information about the stored credential.
 */
export async function verify(plain, encoded) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('verify() requires a non-empty plaintext');
  }
  if (typeof encoded !== 'string' || encoded.length === 0) {
    return false;
  }
  try {
    if (encoded.startsWith('$scrypt$')) return verifyScrypt(plain, encoded);
    // Only reach for Argon2 for hashes this app actually produces. Unknown
    // formats are verification failures and must not load the native module
    // (which is exactly why scrypt mode exists for portable test runs).
    if (!encoded.startsWith('$argon2id$')) return false;
    const argon2 = await loadArgon2();
    return await argon2.verify(encoded, plain);
  } catch {
    return false;
  }
}

/**
 * Determine whether a stored hash should be re-hashed with current
 * parameters. Call this on successful login so older hashes are upgraded
 * transparently the next time the user authenticates.
 *
 * @param {string} encoded - PHC-formatted hash.
 * @returns {boolean} `true` when the hash uses weaker parameters than current.
 */
export function needsRehash(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) return true;
  if (encoded.startsWith('$scrypt$')) {
    const m = /^\$scrypt\$N=(\d+)/.exec(encoded);
    if (!m) return true;
    return Number(m[1]) < MIN_SCRYPT_N;
  }
  if (!encoded.startsWith('$argon2id$')) return true;
  // PHC format: $argon2id$v=19$m=<n>[,t=<n>][,p=<n>]$<salt>$<digest>
  // Parameters can appear in any order - parse each key=value pair.
  const paramsMatch = /\$argon2id\$v=\d+\$([^$]+)\$/.exec(encoded);
  if (!paramsMatch) return true;
  const params = Object.fromEntries(
    paramsMatch[1].split(',').map((kv) => kv.split('=')),
  );
  const memory = Number(params.m);
  const time = Number(params.t);
  if (!Number.isFinite(memory) || !Number.isFinite(time)) return true;
  return memory < MIN_MEMORY_COST || time < MIN_TIME_COST;
}

/* ------------------------------ internals -------------------------------- */

/**
 * Verify a plaintext against a `$scrypt$` PHC hash in constant time.
 *
 * @param {string} plain
 * @param {string} encoded - `$scrypt$N=<n>,r=<n>,p=<n>$<salt>$<hash>`
 * @returns {Promise<boolean>}
 */
async function verifyScrypt(plain, encoded) {
  const m =
    /^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(
      encoded,
    );
  if (!m) return false;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(m[4], 'base64url');
  const expected = Buffer.from(m[5], 'base64url');
  if (expected.length === 0) return false;
  const actual = Buffer.from(
    await scrypt(plain, salt, expected.length, { N, r, p, maxmem: 128 * 1024 * 1024 }),
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export default { hash, verify, needsRehash };
