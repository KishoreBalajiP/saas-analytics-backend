/**
 * XLSX container guard (zip-bomb defence) for the streaming XLSX reader.
 *
 * WHY IT EXISTS
 *   An .xlsx file is a ZIP archive. A few MB of upload can inflate to
 *   gigabytes of XML, and ExcelJS's streaming reader buffers worksheets to
 *   temporary files whenever they appear in the archive before the shared
 *   strings (which is the order Excel itself writes). This module makes the
 *   workbook safe to stream BEFORE any XML is parsed:
 *
 *     1. `inspectXlsx(buffer)` reads the ZIP central directory, rejects
 *        encrypted / ZIP64 / exotic-compression archives, too many entries,
 *        and declared sizes over the budget.
 *     2. `measureInflatedSize(buffer, inspection)` actually inflates the
 *        parts the reader needs, streaming and discarding the output, so a
 *        archive that LIES about its sizes is still caught with bounded
 *        memory.
 *     3. `createOrderedXlsxStream(buffer, inspection)` re-emits only the parts
 *        ExcelJS reads, in the order its streaming reader needs (relations,
 *        workbook, shared strings, styles, then sheets), injecting an empty
 *        shared-strings part when the workbook has none. With that order the
 *        reader never writes temporary files and never buffers a sheet.
 *
 * ERRORS
 *   Typed `ConnectorError`s: `FILE_TOO_LARGE` (413) for budget violations,
 *   `FILE_PARSE_FAILED` (422) for archives that are not usable workbooks.
 */

import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { ConnectorError, CONNECTOR_ERROR_CODES } from '../shared/errors.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const MAX_COMMENT = 0xffff;
export const DEFAULT_MAX_ENTRIES = 2000;

const SHEET_RE = /^xl\/worksheets\/sheet(\d+)\.xml$/;
const PART_ORDER = ['_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/styles.xml'];
const SHARED_STRINGS = 'xl/sharedStrings.xml';
const EMPTY_SHARED_STRINGS = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>',
  'utf8',
);

const invalid = (message = 'The file is not a valid XLSX workbook.') =>
  new ConnectorError(CONNECTOR_ERROR_CODES.FILE_PARSE_FAILED, message, { statusCode: 422 });

const tooLarge = (budget) => new ConnectorError(
  CONNECTOR_ERROR_CODES.FILE_TOO_LARGE,
  `The workbook expands to more than ${Math.round(budget / (1024 * 1024))} MB when uncompressed. Remove unused sheets or split the file.`,
  {
    statusCode: 413,
    // Field-error shape, like the upload middleware's FILE_TOO_LARGE.
    details: [{ field: 'file', message: `maximum uncompressed size is ${Math.round(budget / (1024 * 1024))} MB`, maxBytes: budget }],
  },
);

/** True when the buffer starts like a ZIP archive (local file header). */
export function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.readUInt32LE(0) === SIG_LOCAL;
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - (22 + MAX_COMMENT));
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Read and validate the ZIP central directory.
 *
 * @param {Buffer} buffer
 * @param {Object} [opts]
 * @param {number} opts.maxUncompressedBytes - total budget (declared sizes).
 * @param {number} [opts.maxEntries]
 * @returns {{ entries: Array<Object>, centralDirectoryOffset: number, names: Set<string> }}
 */
export function inspectXlsx(buffer, { maxUncompressedBytes, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  if (!looksLikeZip(buffer) || buffer.length < 22) throw invalid();
  const eocd = findEocd(buffer);
  if (eocd < 0) throw invalid();
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw invalid('ZIP64 workbooks are not supported. Save the file again from your spreadsheet application.');
  }
  if (totalEntries === 0 || totalEntries > maxEntries) throw invalid('The workbook contains too many parts.');
  if (cdOffset + cdSize > eocd) throw invalid();

  const entries = [];
  let declared = 0;
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== SIG_CENTRAL) throw invalid();
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw invalid('Password-protected workbooks are not supported.');
    if (method !== 0 && method !== 8) throw invalid('The workbook uses an unsupported compression method.');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw invalid('ZIP64 workbooks are not supported. Save the file again from your spreadsheet application.');
    }
    if (localOffset + 30 > cdOffset || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) throw invalid();
    declared += uncompressedSize;
    if (declared > maxUncompressedBytes) throw tooLarge(maxUncompressedBytes);
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localOffset });
  }

  // Byte range of every local entry (header + data + optional descriptor):
  // from its header to the next header (or the central directory).
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  byOffset.forEach((entry, i) => {
    entry.end = i + 1 < byOffset.length ? byOffset[i + 1].localOffset : cdOffset;
    const localName = buffer.readUInt16LE(entry.localOffset + 26);
    const localExtra = buffer.readUInt16LE(entry.localOffset + 28);
    entry.dataStart = entry.localOffset + 30 + localName + localExtra;
    if (entry.dataStart + entry.compressedSize > entry.end) throw invalid();
  });

  const names = new Set(entries.map((e) => e.name));
  if (!names.has('xl/workbook.xml') || !names.has('xl/_rels/workbook.xml.rels')) throw invalid();
  if (!entries.some((e) => SHEET_RE.test(e.name))) throw invalid('The workbook has no worksheets.');
  return { entries, centralDirectoryOffset: cdOffset, names };
}

/** The parts the streaming reader needs, in the order it needs them. */
function orderedParts(inspection) {
  const byName = new Map(inspection.entries.map((e) => [e.name, e]));
  const head = PART_ORDER.map((n) => byName.get(n)).filter(Boolean);
  const sheets = inspection.entries
    .filter((e) => SHEET_RE.test(e.name))
    .sort((a, b) => Number(SHEET_RE.exec(a.name)[1]) - Number(SHEET_RE.exec(b.name)[1]));
  return [...head, ...sheets];
}

/**
 * Inflate the parts the reader will consume, counting (and discarding) the
 * output, and fail as soon as the real total passes the budget.
 *
 * @returns {Promise<number>} total inflated bytes.
 */
export async function measureInflatedSize(buffer, inspection, { maxUncompressedBytes }) {
  let total = 0;
  for (const entry of orderedParts(inspection)) {
    const data = buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    if (entry.method === 0) {
      total += data.length;
      if (total > maxUncompressedBytes) throw tooLarge(maxUncompressedBytes);
      continue;
    }
    const inflater = zlib.createInflateRaw();
    inflater.end(data);
    try {
      for await (const chunk of inflater) {
        total += chunk.length;
        if (total > maxUncompressedBytes) throw tooLarge(maxUncompressedBytes);
      }
    } catch (error) {
      inflater.destroy();
      if (error instanceof ConnectorError) throw error;
      throw invalid();
    }
  }
  return total;
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A stored (uncompressed) local entry. */
function storedEntry(name, data) {
  const nameBuf = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(SIG_LOCAL, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuf, data]);
}

/**
 * Re-emit the archive with only the parts ExcelJS reads, in streaming-safe
 * order. The original central directory is appended so the reader sees a
 * normal end of archive (it does not use the offsets).
 *
 * @returns {Readable}
 */
export function createOrderedXlsxStream(buffer, inspection) {
  const chunks = [];
  let injected = inspection.names.has(SHARED_STRINGS);
  for (const entry of orderedParts(inspection)) {
    // The shared strings must precede the sheets: inject an empty part when
    // the workbook has none (right before styles / the first sheet).
    if (!injected && (entry.name === 'xl/styles.xml' || SHEET_RE.test(entry.name))) {
      chunks.push(storedEntry(SHARED_STRINGS, EMPTY_SHARED_STRINGS));
      injected = true;
    }
    chunks.push(buffer.subarray(entry.localOffset, entry.end));
  }
  chunks.push(buffer.subarray(inspection.centralDirectoryOffset));
  return Readable.from(chunks, { objectMode: false });
}

export default { looksLikeZip, inspectXlsx, measureInflatedSize, createOrderedXlsxStream };
