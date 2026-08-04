/**
 * Small, dependency-free object/array helpers shared across layers.
 *
 * WHY IT EXISTS
 *   Avoids re-implementing the same three lines of logic in every service
 *   and gives reviewers a single place to audit utility behaviour.
 *
 * RESPONSIBILITY
 *   Pure functions with no side effects: pick/omit, safe parsing, masking,
 *   pagination math and array chunking.
 *
 * HOW TO EXTEND
 *   Keep functions tiny and pure. If a helper starts needing configuration,
 *   reconsider whether it belongs in `config/`.
 */

import { PAGINATION } from '../config/constants.js';

/** Return a new object containing only the listed keys. */
export function pick(obj, keys) {
  return keys.reduce((acc, key) => {
    if (obj && key in obj) acc[key] = obj[key];
    return acc;
  }, {});
}

/** Return a new object without the listed keys. */
export function omit(obj, keys) {
  const out = { ...obj };
  for (const key of keys) delete out[key];
  return out;
}

/** Safely JSON.parse, returning the fallback (or null) on failure. */
export function safeJsonParse(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Mask a sensitive value for logs, keeping a hint of its shape. */
export function mask(value) {
  if (value === undefined || value === null) return '[REDACTED]';
  const str = String(value);
  if (str.length <= 4) return '****';
  return `${str.slice(0, 2)}****${str.slice(-2)}`;
}

/** Normalise and clamp pagination inputs to safe bounds. */
export function buildPagination(page = PAGINATION.defaultPage, limit = PAGINATION.defaultLimit) {
  const parsedPage = Number.isInteger(page) && page > 0 ? page : PAGINATION.defaultPage;
  const parsedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, PAGINATION.maxLimit) : PAGINATION.defaultLimit;
  return { page: parsedPage, limit: parsedLimit, skip: (parsedPage - 1) * parsedLimit };
}

/** Split an array into chunks of the given size. */
export function chunk(array, size = 100) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/** Sleep helper used across retry / backoff logic. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
