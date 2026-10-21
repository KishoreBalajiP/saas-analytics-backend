/**
 * File upload middleware (multer, memory storage) for connector preview/sync.
 *
 * WHY IT EXISTS
 *   The CSV/XLSX preview and sync endpoints accept `multipart/form-data`
 *   with a single `file` field. Memory storage is intentional: the parsers
 *   stream the buffer row by row, and the size caps keep one upload bounded.
 *
 * VALIDATION (fail before any parsing)
 *   1. Extension pre-filter (before buffering): only .csv, .txt, .xlsx (or no
 *      extension). Legacy .xls and anything else -> 415 UNSUPPORTED_FILE_TYPE.
 *   2. Size: multer caps the buffer at the larger of the CSV/XLSX limits;
 *      the per-type cap is applied once the content type is known.
 *      Too large -> 413 FILE_TOO_LARGE (with the limit in `errors`).
 *   3. Content sniffing: the bytes decide the type, never the client's MIME
 *      header. XLSX = a ZIP with an OOXML workbook; CSV = text (UTF-8 or a
 *      legacy 8-bit code page, no NUL / binary control bytes). Known binary formats, legacy OLE .xls and
 *      other ZIPs -> 415 UNSUPPORTED_FILE_TYPE; extension that contradicts the
 *      content -> 415 FILE_TYPE_MISMATCH.
 *   The detected type is attached as `req.file.detectedType` ('csv'|'xlsx');
 *   the connector service checks it against the connector's own type.
 *
 * ERRORS
 *   Always typed `ApiError`s (never a bare MulterError, which would surface
 *   as HTTP 500).
 */

import multer from 'multer';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import { sniffFileKind } from '../modules/connectors/shared/file-type.js';

export { sniffFileKind };

export const UPLOAD_ERROR_CODES = Object.freeze({
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  FILE_TYPE_MISMATCH: 'FILE_TYPE_MISMATCH',
  UPLOAD_INVALID: 'UPLOAD_INVALID',
});

const ACCEPTED_EXTENSIONS = new Set(['csv', 'txt', 'xlsx']);
const EXTENSION_KIND = Object.freeze({ csv: 'csv', txt: 'csv', xlsx: 'xlsx' });
const toMb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/** Per-type byte caps (read at call time so tests / config changes apply). */
export function uploadLimits() {
  return {
    csv: env.connectors.csvMaxUploadBytes,
    xlsx: env.connectors.xlsxMaxUploadBytes,
  };
}

function extensionOf(name) {
  const match = /\.([a-z0-9]{1,10})$/i.exec(String(name ?? ''));
  return match ? match[1].toLowerCase() : null;
}

export function fileTooLarge(limitBytes, kind) {
  const label = kind ? `${kind.toUpperCase()} uploads` : 'uploads';
  return new ApiError(413, `The file is larger than the ${toMb(limitBytes)} MB limit for ${label}.`, {
    code: UPLOAD_ERROR_CODES.FILE_TOO_LARGE,
    errors: [{ field: 'file', message: `maximum size is ${toMb(limitBytes)} MB`, maxBytes: limitBytes }],
  });
}

export function unsupportedType(message = 'Unsupported file type. Upload a .csv or .xlsx file.') {
  return new ApiError(415, message, {
    code: UPLOAD_ERROR_CODES.UNSUPPORTED_FILE_TYPE,
    errors: [{ field: 'file', message: 'accepted types: .csv, .txt, .xlsx' }],
  });
}

export function typeMismatch(message) {
  return new ApiError(415, message, {
    code: UPLOAD_ERROR_CODES.FILE_TYPE_MISMATCH,
    errors: [{ field: 'file', message }],
  });
}

/* ------------------------------- multer ---------------------------------- */

const fileFilter = (_req, file, cb) => {
  const ext = extensionOf(file.originalname);
  if (ext === 'xls') {
    return cb(unsupportedType('Legacy .xls workbooks are not supported. Save the file as .xlsx and upload it again.'));
  }
  if (ext && !ACCEPTED_EXTENSIONS.has(ext)) return cb(unsupportedType());
  return cb(null, true);
};

function createMulter() {
  const limits = uploadLimits();
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: Math.max(limits.csv, limits.xlsx),
      files: 1,
      fields: 10,
      fieldSize: 4 * 1024,
      parts: 12,
    },
    fileFilter,
  });
}

/**
 * Map multer / busboy / filter errors to typed API errors. Everything that
 * comes out of the multipart parser is a client error, never a 500.
 */
export function toUploadError(err) {
  if (err instanceof ApiError) return err;
  if (err?.code === 'LIMIT_FILE_SIZE') {
    const limits = uploadLimits();
    return fileTooLarge(Math.max(limits.csv, limits.xlsx));
  }
  if (err?.code === 'UNSUPPORTED_FILE_TYPE') return unsupportedType();
  return new ApiError(400, 'The upload is not a valid single-file form submission (field "file").', {
    code: UPLOAD_ERROR_CODES.UPLOAD_INVALID,
  });
}

/** Validate the buffered file (sniffed type, extension agreement, per-type cap). */
export function validateUploadedFile(file) {
  if (!file) return null;
  const kind = sniffFileKind(file.buffer);
  if (kind === 'empty') return null; // the service reports "file required / empty"
  if (kind === 'xls') {
    throw unsupportedType('Legacy .xls workbooks are not supported. Save the file as .xlsx and upload it again.');
  }
  if (kind !== 'csv' && kind !== 'xlsx') throw unsupportedType();
  const ext = extensionOf(file.originalname);
  if (ext && EXTENSION_KIND[ext] && EXTENSION_KIND[ext] !== kind) {
    throw typeMismatch(`The file extension .${ext} does not match its content (${kind.toUpperCase()}).`);
  }
  const cap = uploadLimits()[kind];
  if (file.size > cap || file.buffer.length > cap) throw fileTooLarge(cap, kind);
  return kind;
}

/**
 * Express middleware: accept one `file` field, validate it, and attach
 * `req.file.detectedType`. Requests without a file pass through (the service
 * returns a clear "file required" error).
 */
export function connectorFileUpload(req, res, next) {
  createMulter().single('file')(req, res, (err) => {
    if (err) return next(toUploadError(err));
    try {
      const kind = validateUploadedFile(req.file);
      if (req.file && kind) req.file.detectedType = kind;
      return next();
    } catch (error) {
      return next(error);
    }
  });
}

/** Backwards-compatible handles (same validation as `connectorFileUpload`). */
export const upload = Object.freeze({ single: () => connectorFileUpload });
export const uploadXlsx = upload;

export default upload;
