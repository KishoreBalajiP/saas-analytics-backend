/**
 * File upload middleware (multer, memory storage) for connector sync.
 *
 * WHY IT EXISTS
 *   The CSV/XLSX sync endpoints accept `multipart/form-data` with a single `file`
 *   field. Memory storage is intentional: the parser streams the buffer
 *   line-by-line (never materialising the file), and the size cap keeps one
 *   upload bounded.
 *
 * SECURITY
 *   - File size capped via `CONNECTOR_CSV_MAX_UPLOAD_MB` / `CONNECTOR_XLSX_MAX_UPLOAD_MB`
 *     (multer `limits.fileSize`).
 *   - MIME type + extension sanity-checked; anything unexpected is rejected
 *     with a Multer error before parsing.
 */

import multer from 'multer';
import env from '../config/env.js';

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/octet-stream',
]);
const CSV_EXTENSIONS = /\.(csv|txt)$/i;

const XLSX_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);
const XLSX_EXTENSIONS = /\.(xlsx|xls)$/i;

const ALL_MIME_TYPES = new Set([...CSV_MIME_TYPES, ...XLSX_MIME_TYPES]);
const ALL_EXTENSIONS = /\.(csv|txt|xlsx|xls)$/i;

const fileFilter = (_req, file, cb) => {
  const okMime = ALL_MIME_TYPES.has(file.mimetype);
  const okExt = ALL_EXTENSIONS.test(file.originalname ?? '');
  if (!okMime && !okExt) {
    const err = new Error('Only .csv, .txt, .xlsx, .xls files are accepted');
    err.name = 'MulterError';
    err.code = 'UNSUPPORTED_FILE_TYPE';
    return cb(err);
  }
  return cb(null, true);
};

/** Multer instance for CSV/XLSX uploads (single file, memory storage). */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.connectors.csvMaxUploadBytes,
    files: 1,
  },
  fileFilter,
});

/** XLSX-specific upload with its own size cap. */
export const uploadXlsx = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.connectors.xlsxMaxUploadBytes,
    files: 1,
  },
  fileFilter,
});

export default upload;