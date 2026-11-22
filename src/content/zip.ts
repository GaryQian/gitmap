// A small zip reader for the demo content pack (PLAN.md §12.1): enough to find one entry from the
// archive's directory and inflate it. It never needs the whole archive in hand.
//
// Supported: single-disk archives, methods 0 (stored) and 8 (deflate), UTF-8 names.
// Not supported, and reported as such: zip64 (more than 65,534 entries, or anything at or past 4 GB),
// encrypted entries, other compression methods.

const SIG_END = 0x06054b50;      // end of central directory record
const SIG_CENTRAL = 0x02014b50;  // central directory file header
const SIG_LOCAL = 0x04034b50;    // local file header
const END_MIN = 22;              // the end record without its comment
const LOCAL_MIN = 30;            // a local header without name and extra field

/** The longest an end record can be: its comment is at most 65,535 bytes. */
export const ZIP_END_MAX = END_MIN + 0xffff;

/** The archive itself is wrong or uses something this reader does not handle. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEnd {
  /** Number of entries in the central directory. */
  count: number;
  /** Offset of the central directory in the archive. */
  cdOffset: number;
  cdSize: number;
}

export interface ZipEntry {
  path: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  encrypted: boolean;
  /** Offset of the entry's local header in the archive. */
  offset: number;
  /** Where the next local header (or the central directory) starts: [offset, end) holds the whole entry. */
  end: number;
}

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Find and read the end-of-central-directory record in the last bytes of an archive. */
export function findZipEnd(tail: Uint8Array): ZipEnd {
  const v = view(tail);
  for (let at = tail.length - END_MIN; at >= 0 && at >= tail.length - ZIP_END_MAX; at--) {
    if (v.getUint32(at, true) !== SIG_END) continue;
    if (at + END_MIN + v.getUint16(at + 20, true) !== tail.length) continue; // the signature inside a comment
    const count = v.getUint16(at + 10, true);
    const cdSize = v.getUint32(at + 12, true);
    const cdOffset = v.getUint32(at + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipError('The content pack is a zip64 archive, which is not supported.');
    }
    if (v.getUint16(at + 4, true) !== 0 || v.getUint16(at + 6, true) !== 0 || v.getUint16(at + 8, true) !== count) {
      throw new ZipError('The content pack is a multi-part zip archive, which is not supported.');
    }
    return { count, cdOffset, cdSize };
  }
  throw new ZipError('The content pack is not a zip archive: its directory was not found.');
}

/** Read the central directory. Folder entries are left out. */
export function parseZipDirectory(cd: Uint8Array, end: ZipEnd): ZipEntry[] {
  const v = view(cd);
  const decoder = new TextDecoder();
  const all: ZipEntry[] = [];
  let at = 0;
  for (let i = 0; i < end.count; i++) {
    if (at + 46 > cd.length || v.getUint32(at, true) !== SIG_CENTRAL) throw new ZipError('The content pack has a damaged directory.');
    const nameLen = v.getUint16(at + 28, true);
    const next = at + 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
    if (next > cd.length) throw new ZipError('The content pack has a damaged directory.');
    const entry: ZipEntry = {
      path: decoder.decode(cd.subarray(at + 46, at + 46 + nameLen)),
      encrypted: (v.getUint16(at + 8, true) & 1) !== 0,
      method: v.getUint16(at + 10, true),
      crc32: v.getUint32(at + 16, true),
      compressedSize: v.getUint32(at + 20, true),
      size: v.getUint32(at + 24, true),
      offset: v.getUint32(at + 42, true),
      end: end.cdOffset,
    };
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff) {
      throw new ZipError('The content pack is a zip64 archive, which is not supported.');
    }
    all.push(entry);
    at = next;
  }
  // An entry ends where the next one starts; the directory only records where each begins.
  const byOffset = [...all].sort((a, b) => a.offset - b.offset);
  for (let i = 0; i + 1 < byOffset.length; i++) byOffset[i].end = byOffset[i + 1].offset;
  return all.filter((e) => !e.path.endsWith('/'));
}

/**
 * The entry's file contents, given `span`: bytes of the archive starting at the entry's local header
 * and reaching at least to the end of its data (archive bytes [entry.offset, entry.end) always do).
 */
export async function extractZipEntry(span: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.encrypted) throw new ZipError(`"${entry.path}" is encrypted in the content pack.`);
  const v = view(span);
  if (span.length < LOCAL_MIN || v.getUint32(0, true) !== SIG_LOCAL) throw new ZipError(`"${entry.path}" is not where the content pack's directory says it is.`);
  // name and extra lengths are read from the local header: its extra field may differ from the directory's
  const start = LOCAL_MIN + v.getUint16(26, true) + v.getUint16(28, true);
  if (start + entry.compressedSize > span.length) throw new ZipError(`"${entry.path}" is cut short in the content pack.`);
  const data = span.subarray(start, start + entry.compressedSize);
  let bytes: Uint8Array;
  if (entry.method === 0) bytes = data.slice();
  else if (entry.method === 8) {
    try {
      bytes = await inflateRaw(data);
    } catch {
      throw new ZipError(`"${entry.path}" could not be decompressed.`);
    }
  } else throw new ZipError(`"${entry.path}" uses a compression method (${entry.method}) that is not supported.`);
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc32) throw new ZipError(`"${entry.path}" is damaged in the content pack.`);
  return bytes;
}

/** Inflate a raw deflate stream with the platform's decompressor (browsers, workers, Node 18+). */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
