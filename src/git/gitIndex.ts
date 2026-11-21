// Parser for .git/index, versions 2–4 (PLAN.md §6.2). Pure bytes in, entries out.
import type { IndexEntry } from '../contracts/git';
import { decodeText, toHex } from './bytes';

export type UnsupportedIndexReason = 'split-index' | 'sparse-index' | 'version' | 'sha256' | 'malformed';

/**
 * The index cannot be read into a complete list of tracked files. The caller should fall back to a
 * directory walk (PLAN.md §6.2).
 */
export class UnsupportedIndexError extends Error {
  constructor(readonly reason: UnsupportedIndexReason, message: string) {
    super(message);
    this.name = 'UnsupportedIndexError';
  }
}

const MODE_TYPE_MASK = 0o170000;
const MODE_DIR = 0o040000;

/**
 * Parse .git/index (v2–v4) into tracked entries, in index order (sorted by path bytes).
 * `mtimeMs` is the stat time recorded when the file was staged and may carry a fraction of a millisecond.
 * A path in a merge conflict has up to three staged versions; one entry is kept for it ("ours" when
 * present, otherwise "theirs", otherwise the common ancestor).
 * Throws UnsupportedIndexError for a split index, a sparse index, an unknown version or a damaged file.
 */
export function parseGitIndex(buf: Uint8Array): IndexEntry[] {
  const bad = (msg: string): never => { throw new UnsupportedIndexError('malformed', `git index: ${msg}`); };
  if (buf.length < 12 + 20) bad('file too short');
  if (buf[0] !== 0x44 || buf[1] !== 0x49 || buf[2] !== 0x52 || buf[3] !== 0x43) bad('missing DIRC signature');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint32(4);
  if (version < 2 || version > 4) throw new UnsupportedIndexError('version', `git index: unsupported version ${version}`);
  const count = dv.getUint32(8);
  const end = buf.length - 20; // the SHA-1 trailer follows the entries and extensions
  const out: IndexEntry[] = [];
  let p = 12;
  let prev = new Uint8Array(256); // v4: bytes of the previous path, for prefix compression
  let prevLen = 0;
  let lastStage = 0;
  for (let i = 0; i < count; i++) {
    const start = p;
    if (p + 62 > end) bad('truncated entry');
    const mtimeMs = dv.getUint32(p + 8) * 1000 + dv.getUint32(p + 12) / 1e6;
    const mode = dv.getUint32(p + 24);
    const size = dv.getUint32(p + 36);
    const oid = toHex(buf, p + 40);
    const flags = dv.getUint16(p + 60);
    p += 62;
    if (flags & 0x4000) {
      if (version < 3) bad('extended flags in a version 2 index');
      p += 2;
    }
    let path: string;
    if (version === 4) {
      // Prefix-compressed: a varint N (bytes to drop from the end of the previous path), then the
      // NUL-terminated suffix. The varint is git's "offset" encoding: each continuation adds one.
      let c = buf[p++];
      let strip = c & 127;
      while (c & 128) {
        c = buf[p++];
        strip = (strip + 1) * 128 + (c & 127);
      }
      const nul = buf.indexOf(0, p);
      if (nul < 0 || nul > end || strip > prevLen) bad('bad compressed path');
      const keep = prevLen - strip;
      const len = keep + (nul - p);
      if (len > prev.length) {
        const grown = new Uint8Array(Math.max(len, prev.length * 2));
        grown.set(prev.subarray(0, keep));
        prev = grown;
      }
      prev.set(buf.subarray(p, nul), keep);
      prevLen = len;
      path = decodeText(prev, 0, len);
      p = nul + 1;
    } else {
      const nameLen = flags & 0xfff;
      const nul = nameLen < 0xfff ? p + nameLen : buf.indexOf(0, p);
      if (nul < 0 || nul > end) bad('unterminated path');
      path = decodeText(buf, p, nul);
      // an entry is padded with 1–8 NULs to a multiple of 8 bytes
      p = start + ((nul - start + 8) & ~7);
    }
    if ((mode & MODE_TYPE_MASK) === MODE_DIR) {
      throw new UnsupportedIndexError('sparse-index', `git index: sparse-directory entry "${path}" (sparse index)`);
    }
    const stage = (flags >> 12) & 3;
    const entry: IndexEntry = { path, oid, size, mode, mtimeMs };
    const last = out.length ? out[out.length - 1] : undefined;
    if (stage !== 0 && last && lastStage !== 0 && last.path === path) {
      if (lastStage !== 2) out[out.length - 1] = entry; // prefer stage 2, then 3, then 1
      else continue;
    } else out.push(entry);
    lastStage = stage;
  }
  // Extensions: 4-byte signature, 4-byte size, data. Only two matter, because they change what the entries mean.
  while (p + 8 <= end) {
    const sig = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
    const size = dv.getUint32(p + 4);
    if (sig === 'sdir') throw new UnsupportedIndexError('sparse-index', 'git index: sparse index (sdir extension)');
    if (sig === 'link') {
      // A split index keeps most entries in a shared file. An all-zero base id means "no shared file".
      let hasBase = false;
      for (let k = 0; k < 20 && p + 8 + k < end; k++) if (buf[p + 8 + k] !== 0) { hasBase = true; break; }
      if (hasBase) throw new UnsupportedIndexError('split-index', 'git index: split index (link extension)');
    }
    p += 8 + size;
  }
  return out;
}
