// The background working-tree check (PLAN.md §6.3.1): which tracked files were edited on disk
// without being staged. Two steps, because a browser has no cheap stat and because "a mismatch is
// not yet a change":
//   checkWorkingTree    metadata only: size and modified time on disk against .git/index
//   confirmWorkingTree  reads the few files that mismatched and hashes them the way git hashes a blob
// Neither moves anything: the result feeds planUpdate and the "N files changed · Update" notice.
import type { Config } from '../../config';
import type { IndexEntry, RepoAccess } from '../../contracts/git';
import type { Manifest } from '../../contracts/ingest';
import { hashObject, MODE_GITLINK, MODE_SYMLINK, openGitRepo } from '../../git';
import { extname } from '../../shared';
import { byPath } from './diff';
import type { KnownFile, WorkingTreeChange, WorkingTreeCheckOptions } from './types';

// Not in config.json yet (requested: parser.workingTreeCheck as an object with these three values).
/** Metadata lookups in flight. A lookup is a file-handle resolve in the browser, about 2 ms each. */
const CHECK_CONCURRENCY = 16;
/** Files read and hashed at once by the confirm step. */
const CONFIRM_CONCURRENCY = 4;
/**
 * The index records nanoseconds; a browser's File.lastModified is whole milliseconds and Node's
 * mtimeMs a float. Times closer than this are the same instant seen through different rounding.
 */
const MTIME_TOLERANCE_MS = 2;

const MODE_TYPE_MASK = 0o170000;
const UINT32 = 2 ** 32;

function isManifest(x: readonly IndexEntry[] | readonly KnownFile[] | Manifest): x is Manifest {
  return !Array.isArray(x);
}

/** Run `fn` over the items with at most `limit` in flight, stopping early when the signal aborts. */
async function eachLimit<T>(items: readonly T[], limit: number, signal: AbortSignal | undefined, fn: (item: T) => Promise<void>, onProgress?: (done: number, total: number) => void): Promise<void> {
  let next = 0, done = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !signal?.aborted) {
      await fn(items[next++]);
      onProgress?.(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, worker));
}

/**
 * "Missing" is only believable while the folder itself can be read: a revoked permission makes every
 * file look deleted, and acting on that would empty the map.
 */
async function assertReadable(repo: RepoAccess): Promise<void> {
  let root: unknown[] = [];
  try { root = await repo.tree.list(''); } catch { /* treated as unreadable */ }
  if (root.length === 0) throw new Error('The folder can no longer be read, so its files cannot be compared.');
}

function sameStat(entry: IndexEntry, stat: { size: number; mtimeMs: number }, toleranceMs: number): boolean {
  // The index keeps the size in 32 bits.
  if (stat.size % UINT32 !== entry.size) return false;
  if (Math.abs(stat.mtimeMs - entry.mtimeMs) <= toleranceMs) return true;
  // A git built without sub-second times records whole seconds: compare at that grain.
  return entry.mtimeMs % 1000 === 0 && Math.floor(stat.mtimeMs / 1000) * 1000 === entry.mtimeMs;
}

/**
 * Tracked files whose size or modified time on disk differs from what `.git/index` recorded, plus
 * tracked files that are missing on disk. Sorted paths. Metadata only (`repo.tree.stat`): no file is
 * opened. "Size equal and modified time within tolerance" is unchanged.
 *
 * `entries` is the index as already read, or a manifest: the index is then opened here through
 * `openGitRepo(repo.git)` and restricted to the manifest's paths (a manifest has no modified times).
 * A plain folder, or an index that cannot be read, has nothing to compare with and yields [].
 * Symlinks and submodules are skipped.
 *
 * Aborting the signal resolves with what was found so far. Rejects only when files look missing and
 * the folder turns out to be unreadable as a whole (permission lost).
 *
 * A mismatch is not yet a change (formatters and checkouts touch timestamps): pass the result
 * through confirmWorkingTree before counting it.
 */
export async function checkWorkingTree(repo: RepoAccess, entries: readonly IndexEntry[] | Manifest, opts: WorkingTreeCheckOptions = {}): Promise<string[]> {
  let tracked: readonly IndexEntry[];
  if (isManifest(entries)) {
    if (!repo.git || entries.source !== 'git') return [];
    const wanted = new Set(entries.entries.map((e) => e.path));
    try { tracked = (opts.openGit ?? openGitRepo)(repo.git).indexEntries().filter((e) => wanted.has(e.path)); } catch { return []; }
  } else tracked = entries;

  const seen = new Set<string>();
  const todo = tracked.filter((e) => {
    const type = e.mode & MODE_TYPE_MASK;
    if (type === MODE_SYMLINK || type === MODE_GITLINK || seen.has(e.path)) return false;
    seen.add(e.path);
    return true;
  });
  const tolerance = opts.mtimeToleranceMs ?? MTIME_TOLERANCE_MS;
  const flagged: string[] = [];
  let missing = 0;
  await eachLimit(todo, opts.concurrency ?? CHECK_CONCURRENCY, opts.signal, async (entry) => {
    let stat: { size: number; mtimeMs: number } | null = null;
    try { stat = await repo.tree.stat(entry.path); } catch { /* counts as missing */ }
    if (!stat) { missing++; flagged.push(entry.path); } else if (!sameStat(entry, stat, tolerance)) flagged.push(entry.path);
  }, opts.onProgress);
  if (missing > 0) await assertReadable(repo);
  return flagged.sort(byPath);
}

function hasCrLf(bytes: Uint8Array): boolean {
  for (let i = bytes.indexOf(13); i >= 0; i = bytes.indexOf(13, i + 1)) if (bytes[i + 1] === 10) return true;
  return false;
}

function crLfToLf(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (!(bytes[i] === 13 && bytes[i + 1] === 10)) out[n++] = bytes[i];
  return out.subarray(0, n);
}

/**
 * Of the paths checkWorkingTree flagged, the ones whose content on disk really is not what the map
 * shows. Each file is read and hashed the way git hashes a blob, as it is and with CRLF turned into
 * LF (a checkout with autocrlf), and dropped from the list when either hash is the oid in `known`.
 *
 * `known` is what the map was built from: `knownFiles(state, store)`, or a manifest. Comparing with
 * the map rather than with the index is what stops a file that an earlier Update already took from
 * disk from being offered again on every check.
 *
 * Files the parser never opens (binary by extension, over parser.maxFileBytes) are not read: they
 * count as changed when their size differs from the known one. A flagged file that is gone comes
 * back with `missing: true`.
 *
 * Sorted by path. Aborting resolves with what was confirmed so far. Runs in the calling thread.
 */
export async function confirmWorkingTree(
  repo: RepoAccess,
  paths: readonly string[],
  known: readonly KnownFile[] | Manifest,
  config: Config,
  opts: Pick<WorkingTreeCheckOptions, 'signal' | 'concurrency' | 'onProgress'> = {},
): Promise<WorkingTreeChange[]> {
  const knownBy = new Map<string, KnownFile>();
  for (const k of isManifest(known) ? known.entries : known) knownBy.set(k.path, k);
  const binary = new Set(config.parser.binaryExtensions);
  const changes: WorkingTreeChange[] = [];
  let missing = 0;
  const gone = (path: string): void => { missing++; changes.push({ path, oid: '', missing: true }); };
  await eachLimit([...new Set(paths)], opts.concurrency ?? CONFIRM_CONCURRENCY, opts.signal, async (path) => {
    const was = knownBy.get(path);
    let stat: { size: number; mtimeMs: number } | null = null;
    try { stat = await repo.tree.stat(path); } catch { /* counts as missing */ }
    if (!stat) return gone(path);
    if (binary.has(extname(path)) || stat.size > config.parser.maxFileBytes) {
      if (was?.bytes !== stat.size) changes.push({ path, oid: '', bytes: stat.size });
      return;
    }
    let bytes: Uint8Array | null = null;
    try { bytes = await repo.tree.read(path); } catch { /* counts as missing */ }
    if (!bytes) return gone(path);
    const oid = hashObject('blob', bytes);
    if (was?.oid && (oid === was.oid || (hasCrLf(bytes) && hashObject('blob', crLfToLf(bytes)) === was.oid))) return;
    changes.push({ path, oid, bytes: bytes.length });
  }, opts.onProgress);
  if (missing > 0) await assertReadable(repo);
  return changes.sort((a, b) => byPath(a.path, b.path));
}
