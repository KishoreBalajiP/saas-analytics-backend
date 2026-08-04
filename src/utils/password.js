/**
 * Password hashing utilities.
 *
 * WHY IT EXISTS
 *   User passwords (and admin passwords, service secrets, refresh-token
 *   hashes) must NEVER be stored in clear text. This module is the ONLY
 *   place the application calls Argon2id, so the algorithm parameters can
 *   be tuned in one place as hardware changes.
 *
 * RESPONSIBILITY
 *   - `hash(plain)` -> Argon2id encoded hash (parameters encoded in output).
 *   - `verify(plain, hash)` -> constant-time comparison.
 *   - `needsRehash(hash)` -> detect hashes produced with weaker parameters.
 *
 * DESIGN CONSTRAINTS
 *   - Always uses Argon2id (the OWASP-recommended variant).
 *   - Parameters are tuned for ~150-300ms on modern hardware; bump them on
 *     CI and benchmark before changing.
 *   - Never logs the password or the hash.
 *
 * HOW TO EXTEND
 *   - When migrating to a hardware-backed KDF (e.g. HSM-backed Argon2) only
 *     this module changes; the rest of the codebase uses `hash/verify`.
 */

import argon2 from 'argon2';

/** Argon2id parameters. Keep these conservative but hardware-tunable. */
const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  // memoryCost (KiB). 19 MiB is the OWASP 2024 baseline for Argon2id.
  memoryCost: 19 * 1024,
  // timeCost (iterations).
  timeCost: 2,
  // parallelism (lanes / threads).
  parallelism: 1,
});

/** Rehash when the encoded hash uses weaker parameters than current. */
const MIN_MEMORY_COST = 19 * 1024;
const MIN_TIME_COST = 2;

/* ------------------------------- public --------------------------------- */

/**
 * Hash a plaintext password with Argon2id. The returned string contains the
 * algorithm, parameters, salt and digest in a single PHC-formatted value.
 *
 * @param {string} plain - plaintext password (never logged).
 * @returns {Promise<string>} encoded Argon2id hash.
 * @throws {Error} when `plain` is empty or not a string.
 */
export async function hash(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hash() requires a non-empty string');
  }
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against an Argon2id hash.
 *
 * @param {string} plain - plaintext password.
 * @param {string} encoded - Argon2id encoded hash produced by `hash()`.
 * @returns {Promise<boolean>} `true` when the password matches.
 * @throws {Error} only when `plain` is empty; an empty / malformed hash
 *   is treated as a verification failure to avoid leaking structural
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
 * @param {string} encoded - Argon2id encoded hash.
 * @returns {boolean} `true` when the hash uses weaker parameters than current.
 */
export function needsRehash(encoded) {
  if (typeof encoded !== 'string' || !encoded.startsWith('$argon2id$')) return true;
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

export default { hash, verify, needsRehash };
