// DemoSource (PLAN.md §12.1): one file of a demo's content.zip at a time, by HTTP range request.
//
//   first read   one suffix range request for the end of the archive, which holds its directory
//                (one more when the directory is larger than that tail, or the host misreads "-N")
//   each read    one range request for that entry's local header and data, inflated here
//   verified     the bytes must hash to the blob oid the snapshot recorded for the file
//   cached       verified files go into the Cache API, keyed by oid: reopening needs no network
//   fallback     a host that ignores ranges (a 200 instead of a 206) or fails them gets one download
//                of the whole archive, which is kept and serves every later read
//
// Only archives without zip64 are read (see zip.ts); build-demo.ts writes those.
import type { ContentSource } from '../contracts/git';
import { gitBlobOid } from '../shared';
import { pathOfRef } from './refs';
import { extractZipEntry, findZipEnd, parseZipDirectory, ZIP_END_MAX, ZipError, type ZipEntry } from './zip';

/** The part of the Cache API that is used; a `Cache` satisfies it. */
export interface ContentCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
}

export interface DemoSourceOptions {
  /** The blob oid the snapshot recorded for a path (the file table's `oid` column). */
  oidOf(path: string): string | null | undefined;
  /** Default: the global fetch. */
  fetch?: typeof fetch;
  /** Where opened files are kept. Default: the Cache API store `starmap-demo-content` when there is one. Null turns caching off. */
  cache?: ContentCache | null;
  /** Archive file name under the base URL. Default 'content.zip'. */
  zipName?: string;
  /**
   * Bytes asked for from the end of the archive on the first read. The directory of a 5,000-file demo
   * is about 400 KB, so the default (512 KiB) fetches it in the one request.
   */
  tailBytes?: number;
}

export interface DemoSource extends ContentSource {
  /** How reads are served: one entry per range request, or from one download of the whole archive. Null before the first read. */
  readonly mode: 'range' | 'whole' | null;
  /** Every path in the pack. Fetches the archive's directory when it is not in hand yet. */
  paths(): Promise<string[]>;
}

/** The fetched bytes are not the version of the file the map was built from. */
export class ContentMismatchError extends Error {
  constructor(readonly path: string, readonly expected: string, readonly actual: string) {
    super(`"${path}" in the demo's files does not match the map: expected blob ${expected.slice(0, 10)}, got ${actual.slice(0, 10)}. The demo's files may be out of date.`);
    this.name = 'ContentMismatchError';
  }
}

const CACHE_NAME = 'starmap-demo-content';
const DEFAULT_TAIL_BYTES = 512 * 1024;

async function defaultCache(): Promise<ContentCache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);
  } catch {
    return null; // storage blocked (private mode, an insecure origin)
  }
}

const bodyOf = async (res: Response): Promise<Uint8Array> => new Uint8Array(await res.arrayBuffer());
const octets = (bytes: Uint8Array): Response =>
  new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'application/octet-stream' } });

/** First byte and total size from "Content-Range: bytes 100-199/5000". */
function contentRange(res: Response): { start: number; total: number } | null {
  const m = /^bytes (\d+)-\d+\/(\d+)$/.exec(res.headers.get('Content-Range')?.trim() ?? '');
  return m ? { start: Number(m[1]), total: Number(m[2]) } : null;
}

/**
 * A ContentSource over `<baseUrl>/content.zip`. Nothing is fetched until the first read.
 * `read` accepts 'f:path' and 'u:path'; it rejects with ContentMismatchError when the bytes do not
 * hash to `oidOf(path)`. A path with no recorded oid (a licence file that is not on the map) is
 * served unverified beyond the archive's own CRC, and is not cached.
 */
export function demoSource(baseUrl: string, opts: DemoSourceOptions): DemoSource {
  const zipUrl = (baseUrl.endsWith('/') ? baseUrl : baseUrl + '/') + (opts.zipName ?? 'content.zip');
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const tailBytes = Math.max(opts.tailBytes ?? DEFAULT_TAIL_BYTES, ZIP_END_MAX);
  const cache: Promise<ContentCache | null> = opts.cache === undefined ? defaultCache() : Promise.resolve(opts.cache);
  // The cache only saves time: a failure there (quota, storage cleared) never fails a read.
  const cached = async <T>(fn: (c: ContentCache) => Promise<T>): Promise<T | undefined> => {
    try {
      const c = await cache;
      return c ? await fn(c) : undefined;
    } catch {
      return undefined;
    }
  };
  const blobKey = (oid: string): string => `${zipUrl}?blob=${oid}`;

  let mode: DemoSource['mode'] = null;
  let directory: Promise<Map<string, ZipEntry>> | null = null;
  let whole: Promise<Uint8Array> | null = null;
  let wholeFromCache = false;

  const range = (value: string): Promise<Response> => doFetch(zipUrl, { headers: { Range: value } });

  /** A host answered a range request with the whole archive: keep it, there is nothing more to fetch. */
  function adoptWhole(bytes: Uint8Array): Uint8Array {
    mode = 'whole';
    wholeFromCache = false;
    whole = Promise.resolve(bytes);
    void cached((c) => c.put(zipUrl, octets(bytes)));
    return bytes;
  }

  /** The whole archive: from the cache, or one download that every later read shares. */
  function wholeZip(): Promise<Uint8Array> {
    mode = 'whole';
    if (!whole) {
      const mine: Promise<Uint8Array> = (async () => {
        const hit = await cached(async (c) => {
          const res = await c.match(zipUrl);
          return res ? bodyOf(res) : undefined;
        });
        if (hit) { wholeFromCache = true; return hit; }
        let res: Response;
        try {
          res = await doFetch(zipUrl);
        } catch {
          throw new Error("The demo's files could not be downloaded. Check the connection and open the file again.");
        }
        if (!res.ok) throw new Error(`The demo's files could not be downloaded (HTTP ${res.status}).`);
        const bytes = await bodyOf(res);
        wholeFromCache = false;
        void cached((c) => c.put(zipUrl, octets(bytes)));
        return bytes;
      })();
      whole = mine;
      mine.catch(() => { if (whole === mine) whole = null; }); // a later read may try again
    }
    return whole;
  }

  const index = (entries: ZipEntry[]): Map<string, ZipEntry> => new Map(entries.map((e) => [e.path, e]));

  function directoryOfWhole(bytes: Uint8Array): Map<string, ZipEntry> {
    const end = findZipEnd(bytes.subarray(Math.max(0, bytes.length - ZIP_END_MAX)));
    return index(parseZipDirectory(bytes.subarray(end.cdOffset, end.cdOffset + end.cdSize), end));
  }

  /**
   * One range of the archive. `whole` is set instead when the host answered with the entire file (a
   * 200: it ignores ranges); null when it served neither.
   */
  async function part(value: string): Promise<{ bytes: Uint8Array; at: { start: number; total: number } | null } | { whole: Uint8Array } | null> {
    try {
      const res = await range(value);
      if (res.status === 200) return { whole: adoptWhole(await bodyOf(res)) };
      if (res.status !== 206) return null;
      const at = contentRange(res);
      return { bytes: await bodyOf(res), at };
    } catch {
      return null;
    }
  }

  /** The archive's directory by range request; null when the host does not serve ranges. */
  async function directoryByRange(): Promise<Map<string, ZipEntry> | null> {
    let tail = await part(`bytes=-${tailBytes}`);
    if (tail && 'bytes' in tail && tail.at && tail.at.start + tail.bytes.length !== tail.at.total) {
      // Some hosts misread a suffix range (sirv, behind `vite` and `vite preview`, answers "-N" with
      // bytes 0-N). The answer still says how long the file is, so ask again by position.
      const { total } = tail.at;
      tail = await part(`bytes=${Math.max(0, total - tailBytes)}-${total - 1}`);
    }
    if (!tail) return null;
    if ('whole' in tail) return directoryOfWhole(tail.whole);
    const at = tail.at;
    if (!at || at.start + tail.bytes.length !== at.total) return null; // cannot tell where these bytes sit in the archive
    const end = findZipEnd(tail.bytes);
    let cd: Uint8Array;
    if (end.cdOffset >= at.start) cd = tail.bytes.subarray(end.cdOffset - at.start, end.cdOffset - at.start + end.cdSize);
    else {
      const rest = await part(`bytes=${end.cdOffset}-${end.cdOffset + end.cdSize - 1}`);
      if (!rest) return null;
      if ('whole' in rest) return directoryOfWhole(rest.whole);
      if (rest.bytes.length !== end.cdSize) return null;
      cd = rest.bytes;
    }
    mode = 'range';
    return index(parseZipDirectory(cd, end));
  }

  function entries(): Promise<Map<string, ZipEntry>> {
    if (!directory) {
      const mine = (async () => (mode === 'whole' ? null : await directoryByRange()) ?? directoryOfWhole(await wholeZip()))();
      directory = mine;
      mine.catch(() => { if (directory === mine) directory = null; });
    }
    return directory;
  }

  /** Archive bytes [entry.offset, entry.end) by range request; null when the host did not serve the range. */
  async function spanByRange(entry: ZipEntry): Promise<Uint8Array | null> {
    const got = await part(`bytes=${entry.offset}-${entry.end - 1}`);
    if (!got) return null;
    if ('whole' in got) return got.whole.subarray(entry.offset, entry.end);
    return got.bytes.length === entry.end - entry.offset && (!got.at || got.at.start === entry.offset) ? got.bytes : null;
  }

  async function load(path: string): Promise<Uint8Array> {
    const entry = (await entries()).get(path);
    if (!entry) throw new Error(`"${path}" is not among the demo's files.`);
    const span = (mode === 'range' ? await spanByRange(entry) : null) ?? (await wholeZip()).subarray(entry.offset, entry.end);
    return extractZipEntry(span, entry);
  }

  async function read(path: string, oid: string | null, retried = false): Promise<Uint8Array> {
    if (oid) {
      const hit = await cached(async (c) => {
        const res = await c.match(blobKey(oid));
        const bytes = res ? await bodyOf(res) : undefined;
        if (bytes && (await gitBlobOid(bytes)) !== oid) { await c.delete(blobKey(oid)); return undefined; }
        return bytes;
      });
      if (hit) return hit;
    }
    const usedCachedZip = (): boolean => mode === 'whole' && wholeFromCache;
    let bytes: Uint8Array;
    try {
      bytes = await load(path);
      if (oid) {
        const actual = await gitBlobOid(bytes);
        if (actual !== oid) throw new ContentMismatchError(path, oid, actual);
      }
    } catch (err) {
      // An archive kept from an earlier visit may predate a rebuilt demo: drop it and ask the host once.
      if (retried || !usedCachedZip() || !(err instanceof ContentMismatchError || err instanceof ZipError)) throw err;
      await cached((c) => c.delete(zipUrl));
      whole = null;
      directory = null;
      mode = null;
      return read(path, oid, true);
    }
    // in 'whole' mode the archive itself is what is kept
    if (oid && mode === 'range') void cached((c) => c.put(blobKey(oid), octets(bytes)));
    return bytes;
  }

  return {
    get mode() { return mode; },
    read: (ref) => {
      let path: string;
      try { path = pathOfRef(ref); } catch (err) { return Promise.reject(err); }
      return read(path, opts.oidOf(path) || null);
    },
    paths: async () => [...(await entries()).keys()],
  };
}
