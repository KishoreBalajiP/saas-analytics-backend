/**
 * Export expiry helpers (roadmap 2.7, finding gov.11).
 *
 * WHY IT EXISTS
 *   Audit / access-log exports and report artefacts are downloadable for a
 *   limited window. Once it has passed, the API must stop handing out
 *   download URLs and answer 410 EXPORT_EXPIRED so the client asks for a
 *   new export instead of retrying. Both export surfaces share this error.
 */

import ApiError from './ApiError.js';
import { ERROR_CODES } from '../config/constants.js';

/**
 * 410 for an export whose download window has passed.
 *
 * @param {Date|string|null} [expiredAt] - when the window closed, if known.
 * @param {string} [what='export']
 * @returns {ApiError}
 */
export function exportExpiredError(expiredAt = null, what = 'export') {
  const at = expiredAt ? new Date(expiredAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? ` on ${at.toISOString()}` : '';
  return new ApiError(410, `This ${what} expired${when}. Request a new ${what}.`, {
    code: ERROR_CODES.EXPORT_EXPIRED,
  });
}

/**
 * Whether `expiresAt` is at or before `now`.
 *
 * @param {Date|string|null} expiresAt
 * @param {Date} now
 * @returns {boolean}
 */
export function isPastExpiry(expiresAt, now) {
  if (!expiresAt) return false;
  const at = new Date(expiresAt).getTime();
  return Number.isFinite(at) && at <= now.getTime();
}

export default { exportExpiredError, isPastExpiry };
