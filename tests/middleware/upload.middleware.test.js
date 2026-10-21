/**
 * Unit tests for `middleware/upload.middleware.js` (roadmap 1.7, finding
 * con.10): content sniffing, typed 413 / 415 errors, per-type size caps.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import env from '../../src/config/env.js';
import {
  sniffFileKind,
  validateUploadedFile,
  toUploadError,
  UPLOAD_ERROR_CODES,
} from '../../src/middleware/upload.middleware.js';
import { buildXlsx, buildZip, sheetXml } from '../helpers/zip.js';

const xlsx = buildXlsx([{ name: 'S', xml: sheetXml([['a'], [1]]) }]);
const file = (buffer, originalname) => ({ buffer, originalname, size: buffer.length });

function rejectsWith(fn, status, code) {
  assert.throws(fn, (err) => err.statusCode === status && err.code === code);
}

test('sniffFileKind decides from the bytes, not the name or MIME type', () => {
  assert.equal(sniffFileKind(Buffer.from('id,name\n1,Ada\n')), 'csv');
  assert.equal(sniffFileKind(Buffer.from('﻿id;name\n1;Zoë\n')), 'csv');
  assert.equal(sniffFileKind(xlsx), 'xlsx');
  assert.equal(sniffFileKind(buildZip([{ name: 'a.txt', data: 'x' }])), 'zip');
  assert.equal(sniffFileKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), 'xls');
  assert.equal(sniffFileKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'binary');
  assert.equal(sniffFileKind(Buffer.from('%PDF-1.7\n...')), 'binary');
  assert.equal(sniffFileKind(Buffer.from('a,b\n1,\u0000\n')), 'binary');
  assert.equal(sniffFileKind(Buffer.from([0xff, 0xfe, 0x61, 0x00])), 'binary', 'UTF-16 is not accepted as CSV');
  // Legacy 8-bit exports (Windows-1252 / Latin-1) are text, not binary.
  assert.equal(sniffFileKind(Buffer.from('id;name\n1;José €5\n', 'latin1')), 'csv', 'Latin-1 CSV');
  assert.equal(sniffFileKind(Buffer.from([0x61, 0x2c, 0x80, 0x0a])), 'csv', 'Windows-1252 euro sign');
  // Random bytes (no signature) are still refused: NUL / control bytes.
  const noise = Buffer.alloc(4096);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 7919 + 13) % 256;
  assert.equal(sniffFileKind(noise), 'binary', 'unsigned binary data');
  assert.equal(sniffFileKind(Buffer.from([0x01, 0x02, 0x03, 0x61, 0x62])), 'binary', 'control bytes');
  assert.equal(sniffFileKind(Buffer.alloc(0)), 'empty');
});

test('unsupported content is 415 UNSUPPORTED_FILE_TYPE whatever the extension says', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  rejectsWith(() => validateUploadedFile(file(png, 'data.csv')), 415, UPLOAD_ERROR_CODES.UNSUPPORTED_FILE_TYPE);
  rejectsWith(() => validateUploadedFile(file(png, 'data')), 415, UPLOAD_ERROR_CODES.UNSUPPORTED_FILE_TYPE);
  rejectsWith(() => validateUploadedFile(file(buildZip([{ name: 'x', data: 'y' }]), 'data.xlsx')), 415, UPLOAD_ERROR_CODES.UNSUPPORTED_FILE_TYPE);
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.throws(() => validateUploadedFile(file(ole, 'old.xlsx')), (e) => e.statusCode === 415 && /\.xls/.test(e.message));
});

test('an extension that contradicts the content is 415 FILE_TYPE_MISMATCH', () => {
  rejectsWith(() => validateUploadedFile(file(xlsx, 'renamed.csv')), 415, UPLOAD_ERROR_CODES.FILE_TYPE_MISMATCH);
  rejectsWith(() => validateUploadedFile(file(Buffer.from('a,b\n'), 'renamed.xlsx')), 415, UPLOAD_ERROR_CODES.FILE_TYPE_MISMATCH);
  assert.equal(validateUploadedFile(file(Buffer.from('a,b\n'), 'export.txt')), 'csv');
  assert.equal(validateUploadedFile(file(xlsx, 'book.xlsx')), 'xlsx');
});

test('per-type size caps return 413 FILE_TOO_LARGE with the limit', () => {
  const original = { csv: env.connectors.csvMaxUploadBytes, xlsx: env.connectors.xlsxMaxUploadBytes };
  env.connectors.csvMaxUploadBytes = 64;
  env.connectors.xlsxMaxUploadBytes = 10 * 1024 * 1024;
  try {
    const big = Buffer.from(`a,b\n${'1,2\n'.repeat(40)}`);
    assert.throws(() => validateUploadedFile(file(big, 'big.csv')), (e) => {
      assert.equal(e.statusCode, 413);
      assert.equal(e.code, UPLOAD_ERROR_CODES.FILE_TOO_LARGE);
      assert.equal(e.errors[0].maxBytes, 64);
      return true;
    });
    assert.equal(validateUploadedFile(file(xlsx, 'ok.xlsx')), 'xlsx', 'the XLSX cap applies to XLSX files');
  } finally {
    env.connectors.csvMaxUploadBytes = original.csv;
    env.connectors.xlsxMaxUploadBytes = original.xlsx;
  }
});

test('multer errors map to typed client errors, never 500', () => {
  assert.equal(toUploadError({ name: 'MulterError', code: 'LIMIT_FILE_SIZE' }).statusCode, 413);
  assert.equal(toUploadError({ name: 'MulterError', code: 'LIMIT_FILE_SIZE' }).code, 'FILE_TOO_LARGE');
  assert.equal(toUploadError({ name: 'MulterError', code: 'LIMIT_UNEXPECTED_FILE' }).statusCode, 400);
  assert.equal(toUploadError(new Error('Unexpected end of form')).code, 'UPLOAD_INVALID');
});
