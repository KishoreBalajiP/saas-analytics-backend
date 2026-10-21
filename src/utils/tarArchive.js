/**
 * Minimal streaming tar.gz writer and extractor (roadmap 2.9).
 *
 * WHY IT EXISTS
 *   Tenant data exports are portable archives that any operating system can
 *   open (`tar -xzf export.tar.gz`). The project has no archive dependency,
 *   and the format needed here is small: regular files only, short relative
 *   names, POSIX ustar headers, gzip on top.
 *
 * DESIGN CONSTRAINTS
 *   - Streaming in both directions: file contents are never held in memory
 *     as a whole, so archives of any size within the limits work.
 *   - The extractor treats the archive as untrusted input: only regular
 *     files and directories, names restricted to `[A-Za-z0-9._/-]`, no
 *     absolute paths, no `..` segments, and caps on entry count and total
 *     inflated bytes (gzip-bomb guard). Symlinks, hard links and device
 *     entries are refused.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BLOCK = 512;
const NAME_MAX = 100;
const SIZE_MAX = 8 * 1024 * 1024 * 1024 - 1; // 11 octal digits
const SAFE_NAME = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Default extraction caps (overridable per call). */
export const EXTRACT_LIMITS = Object.freeze({
  maxEntries: 10000,
  maxTotalBytes: 20 * 1024 * 1024 * 1024,
});

/** Typed error for malformed or unsafe archives. */
export class TarError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TarError';
    this.code = code;
    this.isOperational = true;
  }
}

/**
 * Validate an archive member name.
 *
 * @param {string} name
 * @returns {string} the name.
 */
export function assertSafeName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX) {
    throw new TarError('ARCHIVE_ENTRY_UNSAFE', `Archive entry name is empty or longer than ${NAME_MAX} characters`);
  }
  if (!SAFE_NAME.test(name) || name.split('/').some((s) => s === '.' || s === '..')) {
    throw new TarError('ARCHIVE_ENTRY_UNSAFE', `Archive entry name "${name.slice(0, 120)}" is not allowed`);
  }
  return name;
}

function octal(value, width) {
  const digits = value.toString(8);
  if (digits.length > width - 1) throw new TarError('ARCHIVE_ENTRY_TOO_LARGE', 'Value does not fit in a tar header');
  return `${digits.padStart(width - 1, '0')}\0`;
}

function writeString(buf, value, offset, width) {
  buf.write(value.slice(0, width), offset, width, 'utf8');
}

/**
 * Build one 512-byte ustar header.
 *
 * @param {{ name: string, size: number, mtime?: Date }} entry
 * @returns {Buffer}
 */
export function buildHeader({ name, size, mtime = new Date() }) {
  assertSafeName(name);
  if (!Number.isInteger(size) || size < 0 || size > SIZE_MAX) {
    throw new TarError('ARCHIVE_ENTRY_TOO_LARGE', `Archive entry "${name}" is too large`);
  }
  const header = Buffer.alloc(BLOCK, 0);
  writeString(header, name, 0, 100);
  writeString(header, octal(0o644, 8), 100, 8);
  writeString(header, octal(0, 8), 108, 8);
  writeString(header, octal(0, 8), 116, 8);
  writeString(header, octal(size, 12), 124, 12);
  writeString(header, octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12);
  header.fill(0x20, 148, 156); // checksum placeholder: eight spaces
  header[156] = 0x30; // typeflag '0' = regular file
  writeString(header, 'ustar\0', 257, 6);
  writeString(header, '00', 263, 2);
  writeString(header, 'analivo', 265, 32);
  writeString(header, 'analivo', 297, 32);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += header[i];
  writeString(header, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

function padding(size) {
  const rest = size % BLOCK;
  return rest === 0 ? null : Buffer.alloc(BLOCK - rest, 0);
}

/**
 * Write a gzip-compressed tar archive of local files.
 *
 * @param {Object} opts
 * @param {Array<{ name: string, path: string }>} opts.entries - archive name + source file.
 * @param {string} opts.outFile - destination `.tar.gz` path.
 * @returns {Promise<void>}
 */
export async function writeTarGz({ entries, outFile }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TarError('ARCHIVE_EMPTY', 'An archive needs at least one entry');
  }
  const seen = new Set();
  for (const entry of entries) {
    assertSafeName(entry.name);
    if (seen.has(entry.name)) throw new TarError('ARCHIVE_ENTRY_DUPLICATE', `Duplicate archive entry "${entry.name}"`);
    seen.add(entry.name);
  }

  async function* blocks() {
    for (const entry of entries) {
      const stat = await fsp.stat(entry.path);
      if (!stat.isFile()) throw new TarError('ARCHIVE_ENTRY_UNSAFE', `"${entry.name}" is not a regular file`);
      yield buildHeader({ name: entry.name, size: stat.size, mtime: stat.mtime });
      let written = 0;
      for await (const chunk of fs.createReadStream(entry.path)) {
        written += chunk.length;
        yield chunk;
      }
      if (written !== stat.size) {
        throw new TarError('ARCHIVE_SOURCE_CHANGED', `"${entry.name}" changed while it was being archived`);
      }
      const pad = padding(stat.size);
      if (pad) yield pad;
    }
    yield Buffer.alloc(BLOCK * 2, 0);
  }

  await pipeline(Readable.from(blocks()), zlib.createGzip(), fs.createWriteStream(outFile));
}

function readString(buf, offset, width) {
  const raw = buf.subarray(offset, offset + width);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? width : end).toString('utf8');
}

function readOctal(buf, offset, width) {
  const text = readString(buf, offset, width).trim();
  if (!/^[0-7]*$/.test(text)) throw new TarError('ARCHIVE_CORRUPT', 'Malformed tar header');
  return text.length === 0 ? 0 : parseInt(text, 8);
}

function verifyChecksum(header) {
  const stored = readOctal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  if (sum !== stored) throw new TarError('ARCHIVE_CORRUPT', 'Tar header checksum mismatch');
}

/**
 * Extract a `.tar.gz` archive into an (empty or new) directory.
 *
 * @param {Object} opts
 * @param {string} opts.file - source archive.
 * @param {string} opts.destDir - destination directory.
 * @param {number} [opts.maxEntries]
 * @param {number} [opts.maxTotalBytes]
 * @returns {Promise<string[]>} the extracted file names (archive-relative).
 */
export async function extractTarGz({ file, destDir, maxEntries = EXTRACT_LIMITS.maxEntries, maxTotalBytes = EXTRACT_LIMITS.maxTotalBytes }) {
  const root = path.resolve(destDir);
  await fsp.mkdir(root, { recursive: true });
  const names = [];
  let buffer = Buffer.alloc(0);
  let inflated = 0;
  let state = 'header';
  let current = null; // { handle, remaining, pad }
  let finished = false;

  const source = fs.createReadStream(file).pipe(zlib.createGunzip());
  try {
    for await (const chunk of source) {
      inflated += chunk.length;
      if (inflated > maxTotalBytes) throw new TarError('ARCHIVE_TOO_LARGE', 'Archive inflates beyond the allowed size');
      if (finished) continue;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

      for (;;) {
        if (state === 'header') {
          if (buffer.length < BLOCK) break;
          const header = buffer.subarray(0, BLOCK);
          buffer = buffer.subarray(BLOCK);
          if (header.every((b) => b === 0)) {
            finished = true;
            break;
          }
          verifyChecksum(header);
          const prefix = readString(header, 345, 155);
          const name = (prefix ? `${prefix}/` : '') + readString(header, 0, 100);
          const size = readOctal(header, 124, 12);
          const type = String.fromCharCode(header[156] || 0x30);
          const cleanName = name.endsWith('/') ? name.slice(0, -1) : name;
          if (type === '5') {
            assertSafeName(cleanName);
            await fsp.mkdir(path.join(root, cleanName), { recursive: true });
            continue;
          }
          if (type === 'x' || type === 'g') {
            // POSIX extended headers (added when an operator re-packs the
            // archive with a system tar): their attributes are ignored.
            if (size > 1024 * 1024) throw new TarError('ARCHIVE_CORRUPT', 'Extended tar header is too large');
            current = { handle: null, remaining: size, pad: (BLOCK - (size % BLOCK)) % BLOCK };
            state = 'data';
            continue;
          }
          if (type !== '0' && type !== '\0' && type !== '7') {
            throw new TarError('ARCHIVE_ENTRY_UNSAFE', `Archive entry "${cleanName.slice(0, 120)}" is not a regular file`);
          }
          assertSafeName(cleanName);
          if (names.length >= maxEntries) throw new TarError('ARCHIVE_TOO_LARGE', 'Archive has too many entries');
          const target = path.resolve(root, cleanName);
          if (!target.startsWith(root + path.sep)) {
            throw new TarError('ARCHIVE_ENTRY_UNSAFE', `Archive entry "${cleanName}" escapes the destination`);
          }
          await fsp.mkdir(path.dirname(target), { recursive: true });
          const handle = await fsp.open(target, 'wx');
          names.push(cleanName);
          current = { handle, remaining: size, pad: (BLOCK - (size % BLOCK)) % BLOCK };
          state = 'data';
        }
        if (state === 'data') {
          if (current.remaining > 0) {
            if (buffer.length === 0) break;
            const take = Math.min(current.remaining, buffer.length);
            if (current.handle) await current.handle.write(buffer.subarray(0, take));
            buffer = buffer.subarray(take);
            current.remaining -= take;
            if (current.remaining > 0) break;
          }
          if (buffer.length < current.pad) break;
          buffer = buffer.subarray(current.pad);
          if (current.handle) await current.handle.close();
          current = null;
          state = 'header';
        }
      }
    }
  } finally {
    if (current?.handle) await current.handle.close().catch(() => {});
  }
  if (!finished || state !== 'header') throw new TarError('ARCHIVE_CORRUPT', 'Archive ended unexpectedly');
  return names;
}

export default { writeTarGz, extractTarGz, buildHeader, assertSafeName, TarError, EXTRACT_LIMITS };
