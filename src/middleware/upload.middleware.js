/**
 * CSV upload middleware (multer, memory storage).
 *
 * WHY IT EXISTS
 *   The CSV sync endpoint accepts `multipart/form-data` with a single `file`
 *   field. Memory storage is intentional: the CSV parser streams the buffer
 *   line-by-line (never materialising the file), and the size cap keeps one
 *   upload bounded.
 *
 * SECURITY
 *   - File size capped via `CONNECTOR_CSV_MAX_UPLOAD_MB` (multer
 *     `limits.fileSize`).
 *   - MIME type + extension sanity-checked; anything unexpected is rejected
 *     with a Multer error before parsing.
 *
 * HOW TO EXTEND
 *   Swap `memoryStorage` for disk/S3 only if queue workers must re-read the
 *   file later - Sprint 4 parses the buffer immediately.
 */

import multer from 'multer';
import env from '../config/env.js';

const ALLOWED_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/octet-stream',
]);
const ALLOWED_EXTENSIONS = /\.(csv|txt)$/i;

const fileFilter = (_req, file, cb) => {
  const okMime = ALLOWED_MIME_TYPES.has(file.mimetype);
  const okExt = ALLOWED_EXTENSIONS.test(file.originalname ?? '');
  if (!okMime && !okExt) {
    const err = new Error('Only .csv files are accepted');
    err.name = 'MulterError';
    err.code = 'UNSUPPORTED_FILE_TYPE';
    return cb(err);
  }
  return cb(null, true);
};

/**
 * Multer instance for CSV uploads (single file, memory storage).
 *
 * @type {import('multer').Multer}
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.connectors.csvMaxUploadBytes,
    files: 1,
  },
  fileFilter,
});

export default upload;
