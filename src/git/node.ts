// Node-only entry of src/git: never imported by browser code. Package 1C owns this folder.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { DirEntry, GitFs, RepoAccess, WorkingTree } from '../contracts/git';

/** '/'-separated relative path → segments, or null when it could leave the root. */
function segments(p: string): string[] | null {
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  return segs.includes('..') || path.isAbsolute(p) || /[\\\0]/.test(p) ? null : segs;
}

/**
 * GitFs on fs.readSync. Pack files keep their descriptor open for the life of the object (call
 * close() when done); other files are opened per read, so a repo with thousands of loose objects
 * does not hold thousands of descriptors.
 *
 * `commonDir` serves a linked worktree: HEAD and index live in its own git directory, everything
 * else (objects, refs, config) in the main repository's.
 */
export class NodeGitFs implements GitFs {
  private fds = new Map<string, number>();
  constructor(readonly gitDir: string, readonly commonDir: string | null = null) {}

  private locate(p: string): string | null {
    const segs = segments(p);
    if (!segs) return null;
    const own = path.join(this.gitDir, ...segs);
    if (!this.commonDir || fs.existsSync(own)) return own;
    return path.join(this.commonDir, ...segs);
  }

  readAt(p: string, offset: number, length: number): Uint8Array {
    const keep = p.startsWith('objects/pack/');
    let fd = this.fds.get(p);
    if (fd === undefined) {
      const abs = this.locate(p);
      if (!abs) throw new Error(`git: bad path ${p}`);
      fd = fs.openSync(abs, 'r');
      if (keep) this.fds.set(p, fd);
    }
    const buf = new Uint8Array(length);
    let got = 0;
    try {
      while (got < length) {
        const n = fs.readSync(fd, buf, got, length - got, offset + got);
        if (n === 0) break;
        got += n;
      }
    } finally {
      if (!keep) fs.closeSync(fd);
    }
    return got === length ? buf : buf.subarray(0, got);
  }

  size(p: string): number {
    const abs = this.locate(p);
    const st = abs ? fs.statSync(abs, { throwIfNoEntry: false }) : undefined;
    return st?.isFile() ? st.size : -1;
  }

  list(dir: string): string[] {
    const segs = segments(dir);
    if (!segs) return [];
    const names = new Set<string>();
    for (const base of [this.gitDir, this.commonDir]) {
      if (!base) continue;
      try { for (const n of fs.readdirSync(path.join(base, ...segs))) names.add(n); } catch { /* missing */ }
    }
    return [...names].sort();
  }

  /** Close the pack descriptors. The object can still be used afterwards; files are reopened on demand. */
  close(): void {
    for (const fd of this.fds.values()) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    this.fds.clear();
  }
}

/** WorkingTree on node:fs/promises. The root listing leaves out '.git'. */
export class NodeWorkingTree implements WorkingTree {
  constructor(readonly root: string) {}

  private abs(p: string): string | null {
    const segs = segments(p);
    return segs ? path.join(this.root, ...segs) : null;
  }

  async read(p: string): Promise<Uint8Array | null> {
    const abs = this.abs(p);
    if (!abs) return null;
    try {
      const b = await fsp.readFile(abs);
      // hand out a plain Uint8Array that owns its buffer (a Buffer may be a view into a shared pool)
      return b.byteOffset === 0 && b.buffer.byteLength === b.byteLength ? new Uint8Array(b.buffer as ArrayBuffer) : new Uint8Array(b);
    } catch { return null; }
  }

  async stat(p: string): Promise<{ size: number; mtimeMs: number } | null> {
    const abs = this.abs(p);
    if (!abs) return null;
    try {
      const st = await fsp.stat(abs);
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
    } catch { return null; }
  }

  async list(dir: string): Promise<DirEntry[]> {
    const abs = this.abs(dir);
    if (!abs) return [];
    const atRoot = path.resolve(abs) === path.resolve(this.root);
    const out: DirEntry[] = [];
    let ents: fs.Dirent[];
    try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch { return []; }
    for (const e of ents) {
      if (atRoot && e.name === '.git') continue;
      if (e.isDirectory()) out.push({ name: e.name, kind: 'dir' });
      else if (e.isFile()) out.push({ name: e.name, kind: 'file' });
      else if (e.isSymbolicLink()) {
        // a link to a file is a file; a link to a folder is left out, so a walk cannot loop
        try { if ((await fsp.stat(path.join(abs, e.name))).isFile()) out.push({ name: e.name, kind: 'file' }); } catch { /* dangling */ }
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
}

/**
 * Find the git directory of a working tree: `<root>/.git` when it is a directory, or the directory a
 * `.git` file points at (linked worktree or submodule; Node can follow it, the browser cannot).
 */
export function findGitDir(rootPath: string): { gitDir: string; commonDir: string | null } | null {
  const dotGit = path.join(rootPath, '.git');
  const st = fs.statSync(dotGit, { throwIfNoEntry: false });
  if (st?.isDirectory()) return { gitDir: dotGit, commonDir: null };
  if (!st?.isFile()) return null;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
  if (!m) return null;
  const gitDir = path.resolve(rootPath, m[1]);
  if (!fs.statSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) return null;
  let commonDir: string | null = null;
  try { commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
  return { gitDir, commonDir };
}

/** Open a repo on the local file system (scripts and tests). `git` is a NodeGitFs, or null for a plain folder. */
export async function openNodeRepoAccess(rootPath: string): Promise<RepoAccess> {
  const root = path.resolve(rootPath);
  const found = findGitDir(root);
  return {
    name: path.basename(root),
    tree: new NodeWorkingTree(root),
    git: found ? new NodeGitFs(found.gitDir, found.commonDir) : null,
  };
}
