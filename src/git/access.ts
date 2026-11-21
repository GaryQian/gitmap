// Browser-safe repo access (PLAN.md §6.1, §6.3): a File System Access directory handle, a list of
// dropped files, or an in-memory repo. Nothing here may import node:*.
import type { DirEntry, GitFs, RepoAccess, RepoLocator, WorkingTree } from '../contracts/git';

export interface OpenRepoOptions {
  /**
   * 'fsa' only. Up to this many loose objects have their File resolved while the repo is opened (one
   * asynchronous call each). A repo with more is opened with none resolved: see BrowserGitFs.resolveLoose.
   */
  looseLimit?: number;
}

// git packs loose objects once there are about 6,700 of them (gc.auto), so this covers ordinary repos.
const DEFAULT_LOOSE_LIMIT = 20000;
/** getFile() / directory listings kept in flight while a .git directory is resolved. */
const RESOLVE_CONCURRENCY = 32;
/** Files at the top of .git that the readers use. */
const ROOT_FILES = new Set(['HEAD', 'config', 'index', 'packed-refs', 'shallow']);

function cleanPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(?:\.?\/)+/, '').replace(/\/+$/, '');
}

function byName(a: DirEntry, b: DirEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** Directory listings implied by a set of file paths. */
function buildDirs(paths: Iterable<string>): Map<string, DirEntry[]> {
  const dirs = new Map<string, Map<string, 'file' | 'dir'>>();
  const add = (dir: string, name: string, kind: 'file' | 'dir'): boolean => {
    let m = dirs.get(dir);
    if (!m) dirs.set(dir, (m = new Map()));
    if (m.has(name)) return false;
    m.set(name, kind);
    return true;
  };
  for (const path of paths) {
    let cut = path.lastIndexOf('/');
    add(cut < 0 ? '' : path.slice(0, cut), path.slice(cut + 1), 'file');
    // register each ancestor directory with its parent, stopping at one already known
    while (cut >= 0) {
      const dir = path.slice(0, cut);
      const up = dir.lastIndexOf('/');
      if (!add(up < 0 ? '' : dir.slice(0, up), dir.slice(up + 1), 'dir')) break;
      cut = up;
    }
  }
  const out = new Map<string, DirEntry[]>();
  for (const [dir, m] of dirs) out.set(dir, [...m].map(([name, kind]) => ({ name, kind })).sort(byName));
  return out;
}

/** A WorkingTree over files already in hand: dropped File objects, or bytes. */
export class MapWorkingTree implements WorkingTree {
  private dirs: Map<string, DirEntry[]>;
  constructor(private files: Map<string, Blob | Uint8Array>) {
    this.dirs = buildDirs(files.keys());
  }
  async read(path: string): Promise<Uint8Array | null> {
    const f = this.files.get(cleanPath(path));
    if (!f) return null;
    if (f instanceof Uint8Array) return f;
    try { return new Uint8Array(await f.arrayBuffer()); } catch { return null; }
  }
  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    const f = this.files.get(cleanPath(path));
    if (!f) return null;
    if (f instanceof Uint8Array) return { size: f.length, mtimeMs: 0 };
    return { size: f.size, mtimeMs: (f as File).lastModified ?? 0 };
  }
  async list(dir: string): Promise<DirEntry[]> {
    return this.dirs.get(cleanPath(dir)) ?? [];
  }
}

/**
 * A WorkingTree over a File System Access directory handle. Directory handles are cached, so reading
 * many files of one folder resolves the folder once. The root listing leaves out '.git'.
 */
export class FsaWorkingTree implements WorkingTree {
  private dirs = new Map<string, Promise<FileSystemDirectoryHandle | null>>();
  constructor(root: FileSystemDirectoryHandle) {
    this.dirs.set('', Promise.resolve(root));
  }
  private dir(path: string): Promise<FileSystemDirectoryHandle | null> {
    let d = this.dirs.get(path);
    if (!d) {
      const cut = path.lastIndexOf('/');
      d = this.dir(cut < 0 ? '' : path.slice(0, cut))
        .then((parent) => (parent ? parent.getDirectoryHandle(path.slice(cut + 1)) : null))
        .catch(() => null);
      this.dirs.set(path, d);
      // a missing folder is not remembered: it may be created later
      void d.then((h) => { if (!h && this.dirs.get(path) === d) this.dirs.delete(path); });
    }
    return d;
  }
  private async file(path: string): Promise<File | null> {
    const p = cleanPath(path);
    const cut = p.lastIndexOf('/');
    try {
      const dir = await this.dir(cut < 0 ? '' : p.slice(0, cut));
      return dir ? await (await dir.getFileHandle(p.slice(cut + 1))).getFile() : null;
    } catch { return null; }
  }
  async read(path: string): Promise<Uint8Array | null> {
    try {
      const f = await this.file(path);
      return f ? new Uint8Array(await f.arrayBuffer()) : null;
    } catch { return null; }
  }
  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    const f = await this.file(path);
    return f ? { size: f.size, mtimeMs: f.lastModified } : null;
  }
  async list(dir: string): Promise<DirEntry[]> {
    const p = cleanPath(dir);
    const out: DirEntry[] = [];
    try {
      const handle = await this.dir(p);
      if (!handle) return out;
      for await (const [name, h] of handle.entries()) {
        if (p === '' && name === '.git') continue;
        out.push({ name, kind: h.kind === 'directory' ? 'dir' : 'file' });
      }
    } catch { return []; }
    return out.sort(byName);
  }
}

/**
 * A GitFs over File objects (and, for small files, bytes) collected before any synchronous read.
 * Reads go through FileReaderSync on File.slice(), which exists only in workers. On the main thread
 * the small files (HEAD, config, index, packed-refs, shallow, refs, info) are held in memory, so
 * head(), indexEntries() and remoteUrl() work there; object reads throw.
 *
 * It is a snapshot: a File stops being readable once the file changes on disk, and new packs, refs
 * and loose objects are not seen. Call openRepoAccess again to pick up changes.
 */
export class BrowserGitFs implements GitFs {
  private bytes = new Map<string, Uint8Array>();
  private blobs = new Map<string, Blob>();
  private names = new Map<string, Set<string>>();
  private pending: [string, FileSystemFileHandle][] = [];
  private reader: FileReaderSync | null = typeof FileReaderSync !== 'undefined' ? new FileReaderSync() : null;

  /** True when file contents can be read synchronously (in a worker). */
  get canReadBlobs(): boolean { return this.reader !== null; }

  /** Loose objects whose File has not been resolved (see OpenRepoOptions.looseLimit). They read as absent. */
  get unresolvedLoose(): number { return this.pending.length; }

  /** Resolve the loose objects left out when the repo was opened. Needed before a history walk can see them. */
  async resolveLoose(): Promise<void> {
    const todo = this.pending;
    this.pending = [];
    await mapLimit(todo, RESOLVE_CONCURRENCY, async ([path, handle]) => {
      try { this.add(path, await handle.getFile()); } catch { /* vanished: stays absent */ }
    });
  }

  /** @internal */
  add(path: string, content: Blob | Uint8Array): void {
    if (content instanceof Uint8Array) this.bytes.set(path, content);
    else this.blobs.set(path, content);
    // register the name with each ancestor directory, stopping at one already known
    let p = path;
    for (;;) {
      const cut = p.lastIndexOf('/');
      const dir = cut < 0 ? '' : p.slice(0, cut);
      let set = this.names.get(dir);
      if (!set) this.names.set(dir, (set = new Set()));
      const name = p.slice(cut + 1);
      if (set.has(name) || cut < 0) { set.add(name); break; }
      set.add(name);
      p = dir;
    }
  }

  /** @internal */
  defer(loose: [string, FileSystemFileHandle][]): void {
    this.pending = loose;
  }

  /** @internal Without FileReaderSync, pull the small files into memory so they can be read synchronously. */
  async loadSmallFiles(): Promise<void> {
    if (this.reader) return;
    const small = [...this.blobs].filter(([path]) =>
      path.includes('/') ? path.startsWith('refs/') || path.startsWith('info/') : ROOT_FILES.has(path));
    await mapLimit(small, RESOLVE_CONCURRENCY, async ([path, blob]) => {
      try {
        this.bytes.set(path, new Uint8Array(await blob.arrayBuffer()));
        this.blobs.delete(path);
      } catch { /* unreadable: a later read reports it */ }
    });
  }

  readAt(path: string, offset: number, length: number): Uint8Array {
    const b = this.bytes.get(path);
    if (b) return b.subarray(offset, offset + length);
    const blob = this.blobs.get(path);
    if (!blob) throw new Error(`git: no such file .git/${path}`);
    if (!this.reader) {
      throw new Error(`git: reading .git/${path} needs FileReaderSync, which exists only in workers; open the repo in a worker to read objects`);
    }
    try {
      return new Uint8Array(this.reader.readAsArrayBuffer(blob.slice(offset, offset + length)));
    } catch (e) {
      throw new Error(`git: cannot read .git/${path} (it may have changed on disk; reopen the repo): ${String(e)}`, { cause: e });
    }
  }

  size(path: string): number {
    return this.bytes.get(path)?.length ?? this.blobs.get(path)?.size ?? -1;
  }

  list(dir: string): string[] {
    const set = this.names.get(dir.replace(/\/+$/, ''));
    return set ? [...set].sort() : [];
  }
}

function isMissing(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'NotFoundError' || name === 'TypeMismatchError';
}

async function entriesOf(dir: FileSystemDirectoryHandle): Promise<[string, FileSystemHandle][]> {
  const out: [string, FileSystemHandle][] = [];
  for await (const e of dir.entries()) out.push(e);
  return out;
}

const isDir = (h: FileSystemHandle): h is FileSystemDirectoryHandle => h.kind === 'directory';
const isFile = (h: FileSystemHandle): h is FileSystemFileHandle => h.kind === 'file';

/** Collect the File objects of a .git directory that the synchronous readers will ask for. */
async function resolveGitDir(gitDir: FileSystemDirectoryHandle, looseLimit: number): Promise<BrowserGitFs> {
  const fs = new BrowserGitFs();
  const wanted: [string, FileSystemFileHandle][] = [];
  const loose: [string, FileSystemFileHandle][] = [];
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for (const [name, h] of await entriesOf(dir)) {
      if (isFile(h)) wanted.push([prefix + name, h]);
      else if (isDir(h)) await walk(h, prefix + name + '/');
    }
  };
  const root = new Map(await entriesOf(gitDir));
  for (const [name, h] of root) if (isFile(h) && ROOT_FILES.has(name)) wanted.push([name, h]);
  const refs = root.get('refs');
  if (refs && isDir(refs)) await walk(refs, 'refs/');
  const info = root.get('info');
  if (info && isDir(info)) for (const [name, h] of await entriesOf(info)) if (isFile(h)) wanted.push(['info/' + name, h]);
  const objects = root.get('objects');
  if (objects && isDir(objects)) {
    const fanout: [string, FileSystemDirectoryHandle][] = [];
    for (const [name, h] of await entriesOf(objects)) {
      if (!isDir(h)) continue;
      if (name === 'pack') {
        for (const [f, fh] of await entriesOf(h)) if (isFile(fh) && /\.(pack|idx)$/.test(f)) wanted.push(['objects/pack/' + f, fh]);
      } else if (name === 'info') await walk(h, 'objects/info/'); // alternates, commit-graph
      else if (/^[0-9a-f]{2}$/.test(name)) fanout.push([name, h]);
    }
    await mapLimit(fanout, RESOLVE_CONCURRENCY, async ([name, h]) => {
      for (const [f, fh] of await entriesOf(h)) if (isFile(fh) && /^[0-9a-f]{38}$/.test(f)) loose.push([`objects/${name}/${f}`, fh]);
    });
  }
  if (loose.length <= looseLimit) wanted.push(...loose);
  else fs.defer(loose);
  await mapLimit(wanted, RESOLVE_CONCURRENCY, async ([path, handle]) => {
    try { fs.add(path, await handle.getFile()); } catch { /* vanished or unreadable: reads as absent */ }
  });
  await fs.loadSmallFiles();
  return fs;
}

/**
 * Open the repo a locator points at, from a browser worker ('fsa', 'files') or anywhere ('memory').
 * For 'node' locators use openNodeRepoAccess from ./node. `git` is null when there is no .git
 * directory, or when .git is a file (a worktree or submodule whose git directory lies elsewhere).
 */
export async function openRepoAccess(locator: RepoLocator, opts: OpenRepoOptions = {}): Promise<RepoAccess> {
  switch (locator.kind) {
    case 'fsa': {
      const root = locator.root;
      let gitDir: FileSystemDirectoryHandle | null = null;
      try {
        gitDir = await root.getDirectoryHandle('.git');
      } catch (e) {
        if (!isMissing(e)) throw e; // e.g. permission lost: do not mistake it for a plain folder
      }
      const git = gitDir ? await resolveGitDir(gitDir, opts.looseLimit ?? DEFAULT_LOOSE_LIMIT) : null;
      return { name: root.name, tree: new FsaWorkingTree(root), git };
    }
    case 'files':
    case 'memory': {
      const entries: [string, Blob | Uint8Array][] = locator.kind === 'files'
        ? locator.files.map((f) => [f.path, f.file])
        : Object.entries(locator.files);
      const tree = new Map<string, Blob | Uint8Array>();
      const fs = new BrowserGitFs();
      let hasGitDir = false, gitIsFile = false;
      for (const [rawPath, content] of entries) {
        const path = cleanPath(rawPath);
        if (path === '.git') gitIsFile = true;
        else if (path.startsWith('.git/')) { hasGitDir = true; fs.add(path.slice(5), content); }
        else tree.set(path, content);
      }
      const git = hasGitDir && !gitIsFile ? fs : null;
      if (git) await git.loadSmallFiles();
      return { name: locator.name, tree: new MapWorkingTree(tree), git };
    }
    case 'node':
      throw new Error("openRepoAccess: a 'node' locator is opened with openNodeRepoAccess from src/git/node");
  }
}
