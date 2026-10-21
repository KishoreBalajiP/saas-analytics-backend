/**
 * sanitizeError - turn any thrown value into a small, storable error record.
 *
 * WHY IT EXISTS
 *   Job-run and sync-run records persist the reason a run failed so operators
 *   (and, for sync runs, tenant users) can see it. Raw errors can carry stack
 *   traces, connection strings with credentials, or very long driver output.
 *   This helper keeps only a machine code and the first line of the message,
 *   with credentials masked and a hard length cap.
 *
 * USAGE
 *   ```js
 *   await syncRunRepository.finish(id, { status: 'failed', error: sanitizeError(err) });
 *   ```
 */

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const DEFAULT_MAX_LENGTH = 500;

/**
 * Mask credentials that commonly appear in driver/network error messages.
 *
 * @param {string} message
 * @returns {string}
 */
export function redactSecrets(message) {
  return String(message)
    // scheme://user:pass@host -> scheme://***@host (bounded quantifiers:
    // an unbounded scheme match backtracks quadratically on long messages).
    .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]{1,512}@/gi, '$1***@')
    // key=value / key: value pairs for well-known secret names.
    .replace(/\b(password|passwd|secret|token|api[_-]?key|authorization|signingSecret)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2***')
    // Bearer tokens.
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer ***');
}

/**
 * Build a `{ code, message }` record from an error.
 *
 * @param {unknown} err
 * @param {Object} [options]
 * @param {string} [options.fallbackCode='JOB_FAILED'] - code when the error has no usable one.
 * @param {number} [options.maxLength=500] - maximum message length.
 * @returns {{ code: string, message: string } | null}
 */
export function sanitizeError(err, { fallbackCode = 'JOB_FAILED', maxLength = DEFAULT_MAX_LENGTH } = {}) {
  if (err === undefined || err === null) return null;
  const rawCode = typeof err === 'object' ? err.code : undefined;
  const code = typeof rawCode === 'string' && CODE_PATTERN.test(rawCode) ? rawCode : fallbackCode;
  const rawMessage = typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err);
  const firstLine = rawMessage.split('\n')[0].trim() || 'Unknown error';
  const message = redactSecrets(firstLine).slice(0, maxLength);
  return { code, message };
}

export default sanitizeError;
