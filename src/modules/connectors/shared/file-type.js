/**
 * Content sniffing for connector uploads.
 *
 * WHY IT EXISTS
 *   The client's MIME header and file name are not evidence of what a file
 *   is. The upload middleware and the connector service both decide from the
 *   BYTES: an XLSX is a ZIP holding an OOXML workbook; a CSV is text (UTF-8
 *   or a legacy 8-bit code page, no NUL, few control bytes). Everything else is refused before a
 *   parser ever sees it.
 */

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);
const BINARY_SIGNATURES = [
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0xff, 0xd8, 0xff], // JPEG
  [0x1f, 0x8b], // gzip
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
  [0x52, 0x61, 0x72, 0x21], // RAR
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // PE / EXE
  [0x42, 0x5a, 0x68], // bzip2
  [0xff, 0xfe], // UTF-16 LE BOM
  [0xfe, 0xff], // UTF-16 BE BOM
];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];

/** Names in a ZIP central directory (bounded scan; null when unreadable). */
function zipEntryNames(buffer, max = 4096) {
  const min = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < Math.min(count, max); i += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLength = buffer.readUInt16LE(p + 28);
    const extra = buffer.readUInt16LE(p + 30);
    const comment = buffer.readUInt16LE(p + 32);
    names.push(buffer.toString('utf8', p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extra + comment;
  }
  return names;
}

/**
 * Decide what a file really is from its bytes.
 *
 * @param {Buffer} buffer
 * @returns {'csv'|'xlsx'|'xls'|'zip'|'binary'|'empty'}
 */
export function sniffFileKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 'empty';
  if (startsWith(buffer, ZIP_LOCAL)) {
    const names = zipEntryNames(buffer);
    if (names && names.includes('[Content_Types].xml') && names.includes('xl/workbook.xml')) return 'xlsx';
    return 'zip';
  }
  if (startsWith(buffer, OLE2)) return 'xls';
  if (BINARY_SIGNATURES.some((sig) => startsWith(buffer, sig))) return 'binary';
  // Text check on a bounded prefix: no NUL and few control bytes. Bytes
  // >= 0x80 are allowed whether or not they form valid UTF-8: spreadsheet
  // applications commonly export CSV in a legacy 8-bit code page (e.g.
  // Windows-1252), and binary formats are already caught by their NUL /
  // control bytes and the signatures above.
  const sample = buffer.subarray(0, Math.min(buffer.length, 64 * 1024));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return 'binary';
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) control += 1;
  }
  if (control > sample.length * 0.01) return 'binary';
  return 'csv';
}

export default { sniffFileKind };
