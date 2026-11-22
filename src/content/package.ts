// The package file (plan/DEMO-MODE.md §2): one `<name>.starmap.zip` holding a map and its files.
// The app exports it from the settings card; a demo is a package the app opens from its demo list,
// and the same file dropped on the landing page opens as an ordinary import.
//
//   starmap.json           the manifest: what the package is of, and what wrote it
//   map.starmap.json.gz    the model, as exportModelFile writes it (contributor e-mails removed)
//   files/<path>           the text of the files on the map, most important first, to a size budget
//
// Layout rules the reader depends on:
//   - entry order is manifest, map, then files; no zip64
//   - every local header carries its sizes and CRC (no data descriptors), so the manifest and the map
//     can be read off the front of one streaming download while the files are still arriving
//
// Reading (openPackage): ONE request for the whole file. The call resolves as soon as the manifest
// and the map are in hand; the rest of the body is the files, which keep arriving and are then kept
// in the Cache API with the package. A file read before that waits for it.
import { deflateSync } from 'fflate';
import type { ContentSource } from '../contracts/git';
import { encodeModel } from '../model';
import type { RepoModel } from '../model/types';
import { gitBlobOid } from '../shared';
import { pathOfRef } from './refs';
import { crc32, extractZipEntry, findZipEnd, parseZipDirectory, ZIP_END_MAX, ZipError, type ZipEntry } from './zip';

export const PACKAGE_SUFFIX = '.starmap.zip';
export const PACKAGE_FORMAT = 1;
export const MANIFEST_ENTRY = 'starmap.json';
export const MAP_ENTRY = 'map.starmap.json.gz';
export const FILES_PREFIX = 'files/';
/** Root files packed beside the map's own, when the repo has them (they are not on the map). */
export const LICENSE_CANDIDATES = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENCE.txt', 'COPYING', 'COPYING.md', 'COPYING.txt',
  'NOTICE', 'NOTICE.md', 'NOTICE.txt', 'PATENTS', 'AUTHORS',
];

export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  /** The repo's name, as the map has it. */
  name: string;
  /** Where the repo is published, as an https URL; '' when the map has no remote. */
  sourceUrl: string;
  /** The commit the map was built from; '' for a folder without git. */
  commit: string;
  /** SPDX id of the repo's licence, or 'unknown'. */
  license: string;
  /** Milliseconds since the epoch. */
  exportedAt: number;
  parserVersion: string;
  /** Files on the map (packed or not). */
  files: number;
  /** How much of the AI work the map carries: every detail card, some of it, or none. */
  ai: 'complete' | 'partial' | 'none';
  structure: 'full' | 'imports-only';
  /** False when the history walk stopped at its cap, or there was no history. */
  historyComplete: boolean;
  /** The size budget and line floor the files were packed to (0 = none). */
  maxBytes: number;
  minLines: number;
}

// ---- writing ----

/** Where the archive's bytes go, in order. A FileSystemWritableFileStream satisfies it. */
export interface PackageSink {
  write(chunk: Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
  abort?(reason?: unknown): Promise<void> | void;
}

export interface WritePackageOptions {
  /** The map to pack. Contributor e-mails are removed from the copy that is written. */
  model: RepoModel;
  info: Pick<PackageManifest, 'sourceUrl' | 'license' | 'ai'>;
  /**
   * The bytes the map was built from, for a batch of repo-relative paths, in the same order; null for
   * one that cannot be read. Called with a few dozen paths at a time, in pack order.
   */
  read(paths: string[]): Promise<(Uint8Array | null)[]>;
  sink: PackageSink;
  /** Stop adding files once the archive would pass this many bytes. 0 or absent: no budget. */
  maxBytes?: number;
  /** Leave out files with fewer lines than this. 0 or absent: keep all. */
  minLines?: number;
  /** Leave out files longer than this many bytes. 0 or absent: no limit. */
  maxFileBytes?: number;
  /** Extra root files to try (default LICENSE_CANDIDATES); the ones that exist are packed first. */
  extras?: string[];
  /** `done` of `total` candidate files looked at, and the archive's size so far. */
  onProgress?(done: number, total: number, bytes: number): void;
  signal?: AbortSignal;
}

export interface PackageReport {
  manifest: PackageManifest;
  /** Size of the finished archive. */
  bytes: number;
  /** Files of the map that were packed, and their uncompressed size. */
  packedFiles: number;
  rawBytes: number;
  /** Left out for the budget or the line floor. */
  trimmedFiles: number;
  /** Left out because they could not be read, or no longer match the map (edited since the parse). */
  unreadableFiles: number;
  /** Left out because they are binary (a NUL byte near the start) or longer than `maxFileBytes`. */
  skippedFiles: number;
}

/**
 * The order files are packed in, and so what a budget trims: most important first (the unit's
 * importance percentile), larger first among equals. Files under `minLines` are left out.
 */
export function packOrder(model: RepoModel, opts: { minLines?: number } = {}): { paths: string[]; trimmed: number } {
  const minLines = opts.minLines ?? 0;
  // A RepoModel's tables are compacted: one chunk per kind, row r of every column belongs to ids[r].
  const units = model.tables.unit;
  const importance = new Map<string, number>();
  const pct = units.cols.importancePct;
  for (let r = 0; r < units.ids.length; r++) importance.set(units.ids[r], pct?.[r] ?? 0);

  const files = model.tables.file;
  const rows: { path: string; importance: number; loc: number }[] = [];
  let trimmed = 0;
  for (let r = 0; r < files.ids.length; r++) {
    const loc = files.cols.loc?.[r] ?? 0;
    if (loc < minLines) { trimmed++; continue; }
    rows.push({ path: files.ids[r], importance: importance.get(files.cols.unit?.[r] ?? '') ?? 0, loc });
  }
  rows.sort((a, b) => b.importance - a.importance || b.loc - a.loc || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { paths: rows.map((row) => row.path), trimmed };
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const LOCAL_BYTES = 30;    // a local header without its name
const CENTRAL_BYTES = 46;  // a directory record without its name
const END_BYTES = 22;      // the end record, without a comment
const ZIP_VERSION = 20;    // 2.0: deflate
const FLAG_UTF8 = 0x0800;  // general-purpose bit 11: names are UTF-8
/** Without zip64 every offset and size is a 32-bit field, and the entry count a 16-bit one (0xffff is the zip64 marker). */
const ZIP_MAX_BYTES = 0xfffffffe;
const ZIP_MAX_ENTRIES = 65_000;

/** Paths asked of `read` at a time. */
const READ_BATCH = 48;
/** Less room than this under the budget and no further file is read: nothing worth packing would fit. */
const MIN_ROOM = 1024;
/** Entries are handed to the sink in pieces of about this size. */
const FLUSH_BYTES = 4 * 1024 * 1024;
/** Deflating blocks the thread: after this many bytes of files, let the event loop run. */
const YIELD_BYTES = 1024 * 1024;
/** A NUL byte this near the start of a file means it is not text (git's own test). */
const BINARY_PROBE_BYTES = 8000;

interface Packed { method: 0 | 8; crc: number; size: number; data: Uint8Array }

/** An entry's data: deflated, or stored when deflate does not make it smaller (or `store` says so). */
function pack(bytes: Uint8Array, store = false): Packed {
  const crc = crc32(bytes);
  if (!store && bytes.length > 0) {
    const deflated = deflateSync(bytes, { level: 6 });
    if (deflated.length < bytes.length) return { method: 8, crc, size: bytes.length, data: deflated };
  }
  return { method: 0, crc, size: bytes.length, data: bytes };
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/**
 * A zip written front to back: each entry is a local header that already holds its CRC and sizes,
 * then its data; the directory and the end record follow. No data descriptors, no zip64.
 */
class ZipWriter {
  /** Bytes of entries so far: where the next local header goes. */
  offset = 0;
  count = 0;
  private directoryBytes = 0;
  private readonly directory: Uint8Array[] = [];
  private queue: Uint8Array[] = [];
  private queued = 0;
  private readonly time: number;
  private readonly date: number;

  constructor(private readonly sink: PackageSink, when: number) {
    const d = new Date(when);
    const year = Math.min(2107, Math.max(1980, d.getFullYear()));
    this.time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    this.date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  }

  /** What the archive comes to if it ends now: entries, directory and end record. */
  get size(): number { return this.offset + this.directoryBytes + END_BYTES; }
  /** Bytes added but not yet handed to the sink. */
  get pending(): number { return this.queued; }

  /** What one more entry adds to `size`: its local header, its data and its directory record. */
  static cost(name: Uint8Array, data: Uint8Array): number {
    return LOCAL_BYTES + CENTRAL_BYTES + 2 * name.length + data.length;
  }

  add(name: Uint8Array, entry: Packed): void {
    // version needed, flags, method, time, date, CRC, sizes and name length: the same 26 bytes in both records
    const common = (v: DataView, at: number): void => {
      v.setUint16(at, ZIP_VERSION, true);
      v.setUint16(at + 2, FLAG_UTF8, true);
      v.setUint16(at + 4, entry.method, true);
      v.setUint16(at + 6, this.time, true);
      v.setUint16(at + 8, this.date, true);
      v.setUint32(at + 10, entry.crc, true);
      v.setUint32(at + 14, entry.data.length, true);
      v.setUint32(at + 18, entry.size, true);
      v.setUint16(at + 22, name.length, true);
    };
    const local = new Uint8Array(LOCAL_BYTES + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    common(lv, 4);
    local.set(name, LOCAL_BYTES);

    const central = new Uint8Array(CENTRAL_BYTES + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, ZIP_VERSION, true); // made by: 2.0, attribute format 0 (no file modes recorded)
    common(cv, 6);
    cv.setUint32(42, this.offset, true);
    central.set(name, CENTRAL_BYTES);

    this.queue.push(local, entry.data);
    this.queued += local.length + entry.data.length;
    this.offset += local.length + entry.data.length;
    this.directory.push(central);
    this.directoryBytes += central.length;
    this.count++;
  }

  /** Hand what has been added to the sink, as one chunk. */
  async flush(): Promise<void> {
    if (!this.queued) return;
    const chunk = concat(this.queue, this.queued);
    this.queue = [];
    this.queued = 0;
    await this.sink.write(chunk);
  }

  /** Write the directory and the end record. Returns the archive's size. */
  async finish(): Promise<number> {
    await this.flush();
    const end = new Uint8Array(END_BYTES);
    const v = new DataView(end.buffer);
    v.setUint32(0, SIG_END, true);
    v.setUint16(8, this.count, true);
    v.setUint16(10, this.count, true);
    v.setUint32(12, this.directoryBytes, true);
    v.setUint32(16, this.offset, true);
    await this.sink.write(concat([...this.directory, end], this.directoryBytes + END_BYTES));
    return this.size;
  }
}

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_PROBE_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** The bytes with every CRLF turned into LF; the same array when there is none. */
function crlfToLf(bytes: Uint8Array): Uint8Array {
  let first = -1;
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 13 && bytes[i + 1] === 10) { first = i; break; }
  if (first < 0) return bytes;
  const out = new Uint8Array(bytes.length);
  out.set(bytes.subarray(0, first));
  let n = first;
  for (let i = first; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) continue;
    out[n++] = bytes[i];
  }
  return out.slice(0, n);
}

/** The version of `bytes` that hashes to `oid`: as read, or with CRLF line ends undone. Null when neither does. */
async function matching(bytes: Uint8Array, oid: string): Promise<Uint8Array | null> {
  if ((await gitBlobOid(bytes)) === oid) return bytes;
  const lf = crlfToLf(bytes);
  return lf !== bytes && (await gitBlobOid(lf)) === oid ? lf : null;
}

/** The model as it is written: the contributor table keeps names and commit counts, not addresses. */
function withoutEmails(model: RepoModel): RepoModel {
  const contributor = model.tables.contributor;
  return {
    ...model,
    tables: { ...model.tables, contributor: { ...contributor, cols: { ...contributor.cols, emails: contributor.ids.map(() => '') } } },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function write(opts: WritePackageOptions): Promise<PackageReport> {
  const { model, signal } = opts;
  const maxBytes = Math.max(0, opts.maxBytes ?? 0);
  const minLines = Math.max(0, opts.minLines ?? 0);
  const maxFileBytes = Math.max(0, opts.maxFileBytes ?? 0);
  const cancelled = (): void => {
    if (signal?.aborted) throw new DOMException('The export was cancelled.', 'AbortError');
  };
  cancelled();

  const files = model.tables.file;
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    name: model.meta.name,
    sourceUrl: opts.info.sourceUrl,
    commit: model.meta.headOid ?? '',
    license: opts.info.license,
    exportedAt: Date.now(),
    parserVersion: model.meta.parserVersion,
    files: files.ids.length,
    ai: opts.info.ai,
    structure: model.meta.structure,
    historyComplete: model.meta.history?.complete === true,
    maxBytes,
    minLines,
  };

  const encoder = new TextEncoder();
  const zip = new ZipWriter(opts.sink, manifest.exportedAt);
  // The manifest and the map go in whatever the budget: there is no package without them.
  zip.add(encoder.encode(MANIFEST_ENTRY), pack(encoder.encode(JSON.stringify(manifest, null, 2) + '\n')));
  zip.add(encoder.encode(MAP_ENTRY), pack(await encodeModel(withoutEmails(model)), true)); // already gzip
  await zip.flush();
  cancelled();

  const limit = Math.min(maxBytes > 0 ? maxBytes : Infinity, ZIP_MAX_BYTES);
  const full = (): boolean => limit - zip.size < MIN_ROOM || zip.count >= ZIP_MAX_ENTRIES;
  const tooLong = (bytes: Uint8Array): boolean => maxFileBytes > 0 && bytes.length > maxFileBytes;
  /** Add `files/<path>` when it fits; false when it does not. */
  const add = (path: string, bytes: Uint8Array): boolean => {
    const name = encoder.encode(FILES_PREFIX + path);
    const packed = pack(bytes);
    if (name.length > 0xffff || zip.count >= ZIP_MAX_ENTRIES || zip.size + ZipWriter.cost(name, packed.data) > limit) return false;
    zip.add(name, packed);
    return true;
  };

  // Licence and notice files first: they are not on the map, so nothing records what they should hash to.
  const onMap = new Set(files.ids);
  const extras = [...new Set(opts.extras ?? LICENSE_CANDIDATES)].filter((path) => !onMap.has(path));
  if (extras.length && !full()) {
    const got = await opts.read(extras);
    cancelled();
    for (let i = 0; i < extras.length; i++) {
      const bytes = got[i];
      if (bytes && !isBinary(bytes) && !tooLong(bytes)) add(extras[i], bytes);
    }
    await zip.flush();
  }

  const order = packOrder(model, { minLines });
  const paths = order.paths;
  const oids = new Map<string, string>();
  for (let r = 0; r < files.ids.length; r++) oids.set(files.ids[r], files.cols.oid?.[r] ?? '');
  let packedFiles = 0, rawBytes = 0, trimmedFiles = order.trimmed, unreadableFiles = 0, skippedFiles = 0;
  let sinceYield = 0;

  for (let at = 0; at < paths.length; at += READ_BATCH) {
    cancelled();
    if (full()) {
      trimmedFiles += paths.length - at;
      opts.onProgress?.(paths.length, paths.length, zip.offset);
      break;
    }
    const batch = paths.slice(at, at + READ_BATCH);
    const got = await opts.read(batch);
    cancelled();
    for (let i = 0; i < batch.length; i++) {
      const read = got[i];
      if (!read) { unreadableFiles++; continue; }
      if (isBinary(read) || tooLong(read)) { skippedFiles++; continue; }
      if (full()) { trimmedFiles++; continue; }
      const oid = oids.get(batch[i]);
      const bytes = oid ? await matching(read, oid) : read;
      if (!bytes) { unreadableFiles++; continue; }
      if (!add(batch[i], bytes)) { trimmedFiles++; continue; } // a later, smaller file may still fit
      packedFiles++;
      rawBytes += bytes.length;
      if (zip.pending >= FLUSH_BYTES) await zip.flush();
      sinceYield += bytes.length;
      if (sinceYield >= YIELD_BYTES) { sinceYield = 0; await tick(); cancelled(); }
    }
    await zip.flush();
    opts.onProgress?.(Math.min(at + READ_BATCH, paths.length), paths.length, zip.offset);
    await tick(); // a tab stays responsive, and a cancel gets a turn
  }

  cancelled();
  const bytes = await zip.finish();
  await opts.sink.close();
  return { manifest, bytes, packedFiles, rawBytes, trimmedFiles, unreadableFiles, skippedFiles };
}

/**
 * Write a package to `sink`. Every packed file is checked against the blob id the map recorded (a
 * CRLF checkout is normalised first); one that does not match is left out and counted, so a reader's
 * own check never fails on a file that is there. Rejects, after aborting the sink, when cancelled.
 */
export async function writePackage(opts: WritePackageOptions): Promise<PackageReport> {
  try {
    return await write(opts);
  } catch (err) {
    try {
      await opts.sink.abort?.(err);
    } catch {
      // the first failure is the one to report
    }
    throw err;
  }
}

/** "<name>.starmap.zip", with characters a file system would refuse replaced. */
export function packageFileName(model: Pick<RepoModel, 'meta'>): string {
  const name = model.meta.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '');
  return (name || 'map') + PACKAGE_SUFFIX;
}

/** True when a dropped file's name says it is a package. */
export function isPackageFileName(name: string): boolean {
  return name.toLowerCase().endsWith(PACKAGE_SUFFIX);
}

/**
 * An https URL for a remote as .git/config has it ("git@github.com:a/b.git" → "https://github.com/a/b"),
 * or as the model keeps it ("github.com/a/b"); '' when none, and for a remote that is a local path.
 */
export function sourceUrlOf(remoteUrl: string | null | undefined): string {
  const u = (remoteUrl ?? '').trim();
  if (!u) return '';
  const web = (scheme: string, host: string, path: string): string => {
    const tidy = path.replace(/[?#].*$/, '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '').replace(/^\/+/, '');
    return host ? `${scheme}://${host.toLowerCase()}${tidy ? '/' + tidy : ''}` : '';
  };
  const withScheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/.exec(u);
  if (withScheme) {
    const scheme = withScheme[1].toLowerCase();
    const authority = withScheme[2].slice(withScheme[2].lastIndexOf('@') + 1); // without user[:password]@
    if (scheme === 'http' || scheme === 'https') return web(scheme, authority, withScheme[3]);
    if (scheme === 'ssh' || scheme === 'git+ssh' || scheme === 'ssh+git') return web('https', authority.replace(/:\d*$/, ''), withScheme[3]);
    return '';
  }
  // a local path: "/srv/git/a", "..\a", "~/a", "C:\a" (a one-letter host is a Windows drive)
  if (/^[/\\.~]/.test(u) || /^[A-Za-z]:/.test(u)) return '';
  // what the model keeps (normalizeRemoteUrl): host and path, no scheme
  const bare = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?)\/(.+)$/.exec(u);
  if (bare) return web('https', bare[1], bare[2]);
  // scp-like: "[user@]host:path"
  const scp = /^(?:[^@/\\:\s]+@)?([^@/\\:\s]{2,}):(.+)$/.exec(u);
  if (scp) return web('https', scp[1], scp[2]);
  return '';
}

/** A sink that collects the archive in memory, for the plain download where there is no save dialog (and for tests). */
export function memorySink(): PackageSink & { blob(): Blob } {
  // each chunk becomes a Blob as it comes: a copy the caller cannot change, held outside the script heap
  let chunks: Blob[] = [];
  return {
    write(chunk) { chunks.push(new Blob([chunk as Uint8Array<ArrayBuffer>])); },
    close() {},
    abort() { chunks = []; },
    blob: () => new Blob(chunks, { type: 'application/zip' }),
  };
}

// ---- reading ----

/** The part of the Cache API that is used; a `Cache` satisfies it. */
export interface PackageCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
}

/** The file is on the map but was left out of the package (trimmed for size). */
export class NotInPackageError extends Error {
  constructor(readonly path: string) {
    super(`"${path}" is not included in this package.`);
    this.name = 'NotInPackageError';
  }
}

/** The bytes in the package are not the version of the file the map was built from. */
export class PackageMismatchError extends Error {
  constructor(readonly path: string, readonly expected: string, readonly actual: string) {
    super(`"${path}" in the package does not match the map: expected blob ${expected.slice(0, 10)}, got ${actual.slice(0, 10)}.`);
    this.name = 'PackageMismatchError';
  }
}

/** The file is not a package, or was written by a newer format. The message is fit to show. */
export class PackageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageFormatError';
  }
}

export interface PackageContent extends ContentSource {
  /** Settles when every file is in hand; rejects when the download failed (a later read tries again). */
  readonly ready: Promise<void>;
  /** How far the download of the files is. `total` is null when the host did not say. */
  progress(): { loaded: number; total: number | null; done: boolean };
  /** Whether the package holds this path; null while the files are still arriving. */
  has(path: string): boolean | null;
}

export interface OpenedPackage {
  manifest: PackageManifest;
  /** The gzipped map, as decodeModel reads it. */
  map: Uint8Array;
  /**
   * The files. `read` waits for the download, rejects with NotInPackageError for a path the package
   * does not hold and with PackageMismatchError when the bytes do not hash to `oidOf(path)`.
   */
  content: PackageContent;
}

export interface ReadPackageOptions {
  /** The blob oid the map recorded for a path (the file table's `oid` column). Asked at read time. */
  oidOf(path: string): string | null | undefined;
}

export interface OpenPackageOptions extends ReadPackageOptions {
  /** Default: the global fetch. */
  fetch?: typeof fetch;
  /** Where the package is kept for the next visit. Default: the Cache API store `starmap-packages` when there is one. Null turns it off. */
  cache?: PackageCache | null;
  /** Bytes received so far, until the map is in hand (the waiting screen's line). */
  onProgress?(loaded: number, total: number | null): void;
  signal?: AbortSignal;
}

const CACHE_NAME = 'starmap-packages';
// What the host said about the copy that is kept, saved with it: a Response in the Cache API keeps its headers.
const KEPT_ETAG = 'X-Package-ETag';
const KEPT_MODIFIED = 'X-Package-Last-Modified';
const KEPT_LENGTH = 'X-Package-Content-Length'; // the host's Content-Length, as it sent it
const KEPT_SIZE = 'X-Package-Size';             // the archive's own size
/** Read from the end of a package to find its directory; one of 20,000 files is about 2 MB. */
const TAIL_BYTES = ZIP_END_MAX + 256 * 1024;
/** Received chunks are folded into one Blob each time this many bytes have come in. */
const FOLD_BYTES = 4 * 1024 * 1024;

const NOT_A_PACKAGE = 'This file is not a Starmap package, or it is damaged.';
const NEWER_FORMAT = 'This package was written by a newer version of the app.';
const DOWNLOAD_FAILED = 'The demo could not be downloaded. Check the connection and try again.';
const FILES_FAILED = "The demo's files could not be downloaded. Check the connection and open the file again.";

/** The two entries every reader needs first. */
interface Front { manifest: PackageManifest; map: Uint8Array }

/** A package that is wholly in hand. */
interface Pack extends Front {
  blob: Blob;
  /** Repo-relative path → its `files/` entry. */
  files: Map<string, ZipEntry>;
}

async function bytesOf(blob: Blob, start = 0, end = blob.size): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function parseManifest(bytes: Uint8Array): PackageManifest {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PackageFormatError(NOT_A_PACKAGE);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new PackageFormatError(NOT_A_PACKAGE);
  const format = (doc as { format?: unknown }).format;
  if (typeof format !== 'number') throw new PackageFormatError(NOT_A_PACKAGE);
  if (format > PACKAGE_FORMAT) throw new PackageFormatError(NEWER_FORMAT);
  return doc as PackageManifest;
}

/**
 * Open a package through its directory, at the end of the archive. `front` is the manifest and the
 * map when they have been read already.
 */
async function openBlob(blob: Blob, front?: Front | null): Promise<Pack> {
  let entries: ZipEntry[];
  try {
    const tailStart = Math.max(0, blob.size - TAIL_BYTES);
    const tail = await bytesOf(blob, tailStart);
    const end = findZipEnd(tail);
    const cd = end.cdOffset >= tailStart
      ? tail.subarray(end.cdOffset - tailStart, end.cdOffset - tailStart + end.cdSize)
      : await bytesOf(blob, end.cdOffset, end.cdOffset + end.cdSize);
    entries = parseZipDirectory(cd, end);
  } catch (err) {
    throw err instanceof ZipError ? new PackageFormatError(NOT_A_PACKAGE) : err;
  }
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const extract = async (name: string): Promise<Uint8Array> => {
    const entry = byPath.get(name);
    if (!entry) throw new PackageFormatError(`This zip file is not a Starmap package: it has no ${name}.`);
    try {
      return await extractZipEntry(await bytesOf(blob, entry.offset, entry.end), entry);
    } catch (err) {
      throw err instanceof ZipError ? new PackageFormatError(NOT_A_PACKAGE) : err;
    }
  };
  const manifest = front?.manifest ?? parseManifest(await extract(MANIFEST_ENTRY));
  const map = front?.map ?? await extract(MAP_ENTRY);
  const files = new Map<string, ZipEntry>();
  for (const e of entries) if (e.path.startsWith(FILES_PREFIX)) files.set(e.path.slice(FILES_PREFIX.length), e);
  return { manifest, map, blob, files };
}

async function readEntry(pack: Pack, path: string, oidOf: ReadPackageOptions['oidOf']): Promise<Uint8Array> {
  const entry = pack.files.get(path);
  if (!entry) throw new NotInPackageError(path);
  const bytes = await extractZipEntry(await bytesOf(pack.blob, entry.offset, entry.end), entry);
  const oid = oidOf(path);
  if (oid) {
    const actual = await gitBlobOid(bytes);
    if (actual !== oid) throw new PackageMismatchError(path, oid, actual);
  }
  return bytes;
}

/** The files of a package that is wholly in hand. */
function packContent(pack: Pack, oidOf: ReadPackageOptions['oidOf']): PackageContent {
  return {
    ready: Promise.resolve(),
    progress: () => ({ loaded: pack.blob.size, total: pack.blob.size, done: true }),
    has: (path) => pack.files.has(path),
    read: async (ref) => readEntry(pack, pathOfRef(ref), oidOf),
  };
}

/**
 * The local header at `at`, as the entry it describes, when it is `name`'s and says everything
 * needed to read the entry without the directory. A number: that many bytes of the archive are
 * needed to tell. Null: it is something else (another entry, sizes left to a data descriptor, zip64,
 * encrypted).
 */
function localHeader(bytes: Uint8Array, at: number, name: Uint8Array): ZipEntry | number | null {
  if (bytes.length < at + LOCAL_BYTES) return at + LOCAL_BYTES;
  const v = new DataView(bytes.buffer, bytes.byteOffset + at, LOCAL_BYTES);
  if (v.getUint32(0, true) !== SIG_LOCAL || v.getUint16(26, true) !== name.length) return null;
  const data = at + LOCAL_BYTES + name.length + v.getUint16(28, true);
  if (bytes.length < at + LOCAL_BYTES + name.length) return data;
  for (let i = 0; i < name.length; i++) if (bytes[at + LOCAL_BYTES + i] !== name[i]) return null;
  const flags = v.getUint16(6, true), method = v.getUint16(8, true);
  const compressedSize = v.getUint32(18, true), size = v.getUint32(22, true);
  // bit 0: encrypted; bit 3: the sizes follow the data instead
  if ((flags & 0x0009) !== 0 || (method !== 0 && method !== 8) || compressedSize === 0xffffffff || size === 0xffffffff) return null;
  return {
    path: new TextDecoder().decode(name), method, crc32: v.getUint32(14, true), compressedSize, size,
    encrypted: false, offset: at, end: data + compressedSize,
  };
}

/**
 * Reads the manifest and the map off the front of a package as its bytes arrive. Feed it each chunk:
 * it answers undefined while more are needed, then the two entries; null when the archive does not
 * start with them (written by another tool), which only the directory can sort out. Rejects with
 * PackageFormatError as soon as the manifest says the package cannot be read.
 */
function frontReader(): (chunk: Uint8Array) => Promise<Front | null | undefined> {
  const encoder = new TextEncoder();
  const manifestName = encoder.encode(MANIFEST_ENTRY), mapName = encoder.encode(MAP_ENTRY);
  let chunks: Uint8Array[] = [];
  let have = 0;
  let need = LOCAL_BYTES;
  let manifest: PackageManifest | null = null;
  return async (chunk) => {
    chunks.push(chunk);
    have += chunk.length;
    if (have < need) return undefined;
    const bytes = chunks.length === 1 ? chunks[0] : concat(chunks, have);
    chunks = [bytes];
    const first = localHeader(bytes, 0, manifestName);
    if (first === null) return null;
    if (typeof first === 'number') { need = first; return undefined; }
    if (bytes.length < first.end) { need = first.end; return undefined; }
    try {
      manifest ??= parseManifest(await extractZipEntry(bytes.subarray(0, first.end), first));
      const second = localHeader(bytes, first.end, mapName);
      if (second === null) return null;
      if (typeof second === 'number') { need = second; return undefined; }
      if (bytes.length < second.end) { need = second.end; return undefined; }
      return { manifest, map: await extractZipEntry(bytes.subarray(second.offset, second.end), second) };
    } catch (err) {
      if (err instanceof ZipError) return null;
      throw err;
    }
  };
}

async function defaultCache(): Promise<PackageCache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);
  } catch {
    return null; // storage blocked (private mode, an insecure origin)
  }
}

/**
 * Whether the host still serves the copy that was kept: by ETag when both have one, else by
 * Last-Modified and (when both say) Content-Length. Nothing to go by counts as changed.
 */
function sameVersion(kept: Headers, host: Headers): boolean {
  const tag = (value: string | null): string => (value ?? '').trim().replace(/^W\//, '');
  const keptTag = tag(kept.get(KEPT_ETAG)), hostTag = tag(host.get('ETag'));
  if (keptTag && hostTag) return keptTag === hostTag;
  const keptModified = kept.get(KEPT_MODIFIED), hostModified = host.get('Last-Modified');
  if (!keptModified || !hostModified || keptModified !== hostModified) return false;
  const keptLength = kept.get(KEPT_LENGTH), hostLength = host.get('Content-Length');
  return !keptLength || !hostLength || keptLength === hostLength;
}

/**
 * The files of a package whose download is `first`. When that fails, `ready` and the reads waiting
 * on it reject; the next read calls `again` (one download, shared by every read until it settles).
 */
function arrivingContent(
  first: Promise<Pack>, again: () => Promise<Pack>,
  state: { loaded: number; total: number | null; done: boolean }, oidOf: ReadPackageOptions['oidOf'],
): PackageContent {
  let pack: Pack | null = null;
  let failed = false;
  let files!: Promise<Pack>;
  let ready!: Promise<void>;
  const follow = (attempt: Promise<Pack>): void => {
    failed = false;
    const mine: Promise<Pack> = attempt.then(
      (p) => { pack = p; return p; },
      (err: unknown) => {
        if (files === mine) failed = true;
        // a cancelled download says so; anything else gets the sentence the sidebar shows
        throw err instanceof Error && err.name === 'AbortError' ? err : new Error(FILES_FAILED);
      },
    );
    files = mine;
    ready = mine.then(() => undefined);
    ready.catch(() => {}); // nobody may be listening: a failure is reported to the reads
  };
  follow(first);
  return {
    get ready() { return ready; },
    progress: () => ({ ...state }),
    has: (path) => (pack ? pack.files.has(path) : null),
    read: async (ref) => {
      const path = pathOfRef(ref);
      if (failed) follow(again());
      return readEntry(await files, path, oidOf);
    },
  };
}

/**
 * Open a package by URL. Resolves once the manifest and the map have arrived; `content` goes on
 * receiving the files from the same response. A package kept from an earlier visit is used when the
 * host still reports the same size and validator (or cannot be reached); otherwise it is replaced.
 */
export async function openPackage(url: string, opts: OpenPackageOptions): Promise<OpenedPackage> {
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const { signal, oidOf } = opts;
  const cache: Promise<PackageCache | null> = opts.cache === undefined ? defaultCache() : Promise.resolve(opts.cache);
  // The cache only saves time: a failure there (quota, storage cleared) never fails an open or a read.
  const cached = async <T>(fn: (c: PackageCache) => Promise<T>): Promise<T | undefined> => {
    try {
      const c = await cache;
      return c ? await fn(c) : undefined;
    } catch {
      return undefined;
    }
  };

  // ---- a copy kept from an earlier visit ----
  const kept = await cached((c) => c.match(url));
  if (kept) {
    let current = true; // a host that cannot be asked (offline) is taken to still serve what is kept
    try {
      const head = await doFetch(url, { method: 'HEAD', signal });
      if (head.ok) current = sameVersion(kept.headers, head.headers);
    } catch (err) {
      if (signal?.aborted) throw err;
    }
    if (current) {
      try {
        const pack = await openBlob(await kept.blob());
        return { manifest: pack.manifest, map: pack.map, content: packContent(pack, oidOf) };
      } catch {
        // damaged: fetch it again
      }
    }
    await cached((c) => c.delete(url));
  }

  // ---- one download of the whole file ----
  const state = { loaded: 0, total: null as number | null, done: false };
  let opened = false; // the caller has its map: progress is content.progress()'s business from here

  /** One GET. `onFront` is told when the manifest and the map have come off the front of the body. */
  const download = async (onFront?: (front: Front) => void): Promise<Pack> => {
    state.loaded = 0;
    state.total = null;
    state.done = false;
    let res: Response;
    try {
      res = await doFetch(url, { signal });
    } catch (err) {
      throw signal?.aborted ? err : new Error(DOWNLOAD_FAILED);
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw new Error(`The demo could not be downloaded (HTTP ${res.status}).`);
    }
    // with a Content-Encoding the length is of the encoded body, not of the bytes that arrive here
    const length = res.headers.get('Content-Encoding') ? NaN : Number(res.headers.get('Content-Length') ?? NaN);
    state.total = Number.isFinite(length) && length > 0 ? length : null;

    const parts: Blob[] = [];
    let pending: Uint8Array<ArrayBuffer>[] = [];
    let pendingBytes = 0;
    let feed = onFront ? frontReader() : null;
    const seen: { front: Front | null } = { front: null };
    const take = async (chunk: Uint8Array<ArrayBuffer> | undefined): Promise<void> => {
      if (!chunk || !chunk.length) return;
      state.loaded += chunk.length;
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes >= FOLD_BYTES) {
        parts.push(new Blob(pending));
        pending = [];
        pendingBytes = 0;
      }
      if (!opened) opts.onProgress?.(state.loaded, state.total);
      if (!feed) return;
      const front = await feed(chunk);
      if (front === undefined) return;
      feed = null;
      if (front) { seen.front = front; onFront!(front); }
    };
    try {
      if (res.body) {
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await take(value);
          }
        } catch (err) {
          void reader.cancel().catch(() => {});
          throw err;
        }
      } else await take(new Uint8Array(await res.arrayBuffer()));
    } catch (err) {
      if (signal?.aborted || err instanceof PackageFormatError) throw err;
      throw new Error(DOWNLOAD_FAILED);
    }
    if (pending.length) parts.push(new Blob(pending));
    const blob = new Blob(parts, { type: 'application/zip' });
    const pack = await openBlob(blob, seen.front);
    state.done = true;

    const headers: Record<string, string> = { 'Content-Type': 'application/zip', [KEPT_SIZE]: String(blob.size) };
    const etag = res.headers.get('ETag'), modified = res.headers.get('Last-Modified'), sent = res.headers.get('Content-Length');
    if (etag) headers[KEPT_ETAG] = etag;
    if (modified) headers[KEPT_MODIFIED] = modified;
    if (sent) headers[KEPT_LENGTH] = sent;
    void cached((c) => c.put(url, new Response(blob, { headers })));
    return pack;
  };

  let front: Front | null = null;
  let frontSeen!: () => void;
  const frontOrEnd = new Promise<void>((resolve) => { frontSeen = resolve; });
  const first = download((f) => { front = f; opened = true; frontSeen(); });
  const content = arrivingContent(first, () => download(), state, oidOf);
  first.then(frontSeen, frontSeen);
  await frontOrEnd;
  const early = front as Front | null; // assigned in the callback above
  if (early) return { manifest: early.manifest, map: early.map, content };
  // The archive does not start with the manifest and the map: it was all needed to find them.
  const pack = await first;
  opened = true;
  return { manifest: pack.manifest, map: pack.map, content };
}

/** Open a package the viewer has in hand (a dropped file). Nothing is cached. */
export async function readPackage(file: Blob, opts: ReadPackageOptions): Promise<OpenedPackage> {
  const pack = await openBlob(file);
  return { manifest: pack.manifest, map: pack.map, content: packContent(pack, opts.oidOf) };
}
