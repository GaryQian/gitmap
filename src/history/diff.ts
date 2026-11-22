// The work of one chunk: diff each commit's tree against its first parent's and total the touched
// paths. Ported from spikes/git/core/history.ts, whose output matched `git log` on four repositories.
// The diff walks two tree objects in step, descends only into subtrees whose ids differ, and never
// reads a blob. Renames are not followed: a path's history is the history of that path.
import { hexToBytes, T_COMMIT, T_TREE, type ObjectDb } from '../git';
import { parseCommitHeader } from './commit';
import type { ChunkInput, ChunkOutput } from './types';

const MODE_TREE = 0o40000;
const td = new TextDecoder();

/** Text of b[s..e): a tree entry's name. Short ASCII names skip the decoder. */
function nameAt(b: Uint8Array, s: number, e: number): string {
  if (e - s < 48) {
    let r = '';
    for (let i = s; i < e; i++) {
      const c = b[i];
      if (c > 127) return td.decode(b.subarray(s, e));
      r += String.fromCharCode(c);
    }
    return r;
  }
  return td.decode(b.subarray(s, e));
}

/**
 * Path ids of one worker. Paths are resolved one directory level at a time from short names, so the
 * diff builds and hashes a full path string only the first time it meets a file.
 */
export class PathTable {
  /** id → repo-relative path. */
  readonly paths: string[] = [];
  private dirPath: string[] = [''];
  private dirDirs: (Map<string, number> | undefined)[] = [undefined];
  private dirFiles: (Map<string, number> | undefined)[] = [undefined];

  childDir(dir: number, name: string): number {
    let m = this.dirDirs[dir];
    if (!m) this.dirDirs[dir] = m = new Map();
    let id = m.get(name);
    if (id === undefined) {
      id = this.dirPath.length;
      this.dirPath.push(this.dirPath[dir] + name + '/');
      this.dirDirs.push(undefined);
      this.dirFiles.push(undefined);
      m.set(name, id);
    }
    return id;
  }

  childFile(dir: number, name: string): number {
    let m = this.dirFiles[dir];
    if (!m) this.dirFiles[dir] = m = new Map();
    let id = m.get(name);
    if (id === undefined) {
      id = this.paths.length;
      this.paths.push(this.dirPath[dir] + name);
      m.set(name, id);
    }
    return id;
  }
}

/** Thrown when a tree is not on disk (partial clone, damaged repository). */
export class MissingObjectError extends Error {}

export class TreeDiffer {
  constructor(private odb: ObjectDb, private table: PathTable) {}

  private readTree(oid: Uint8Array, at: number): Uint8Array {
    const o = this.odb.read(oid, at);
    if (!o || o.type !== T_TREE) throw new MissingObjectError('git: tree object is missing');
    return o.data;
  }

  /** Path ids of the files that differ between two root trees (hex ids; `oldTree` null = everything is new). */
  changed(newTree: string, oldTree: string | null, out: number[]): void {
    if (newTree === oldTree) return;
    this.diff(this.readTree(hexToBytes(newTree), 0), oldTree ? this.readTree(hexToBytes(oldTree), 0) : null, 0, out);
  }

  /** Diff tree object `a` (new) against `b` (old); push the ids of changed files to `out`. */
  private diff(a: Uint8Array | null, b: Uint8Array | null, dir: number, out: number[]): void {
    const al = a ? a.length : 0, bl = b ? b.length : 0;
    const t = this.table;
    let i = 0, j = 0;
    let aMode = 0, aName = 0, aNameEnd = 0, aOid = 0, aTree = false;
    let bMode = 0, bName = 0, bNameEnd = 0, bOid = 0, bTree = false;
    let needA = true, needB = true;
    for (;;) {
      if (needA && i < al) {
        let m = 0, p = i;
        while (a![p] !== 32) m = m * 8 + (a![p++] - 48);
        aMode = m; aName = p + 1; p = aName;
        while (a![p] !== 0) p++;
        aNameEnd = p; aOid = p + 1; aTree = m === MODE_TREE;
        needA = false;
      }
      if (needB && j < bl) {
        let m = 0, p = j;
        while (b![p] !== 32) m = m * 8 + (b![p++] - 48);
        bMode = m; bName = p + 1; p = bName;
        while (b![p] !== 0) p++;
        bNameEnd = p; bOid = p + 1; bTree = m === MODE_TREE;
        needB = false;
      }
      const haveA = i < al, haveB = j < bl;
      if (!haveA && !haveB) return;
      let cmp: number;
      if (!haveA) cmp = 1;
      else if (!haveB) cmp = -1;
      else {
        // git's tree order: by name bytes, a directory comparing as if its name ended in '/'
        const la = aNameEnd - aName, lb = bNameEnd - bName;
        const ml = la < lb ? la : lb;
        cmp = 0;
        for (let k = 0; k < ml; k++) {
          const d = a![aName + k] - b![bName + k];
          if (d !== 0) { cmp = d; break; }
        }
        if (cmp === 0) {
          const ca = la > ml ? a![aName + ml] : aTree ? 47 : 0;
          const cb = lb > ml ? b![bName + ml] : bTree ? 47 : 0;
          cmp = ca - cb;
        }
      }
      if (cmp < 0) {
        // only in the new tree: added
        const name = nameAt(a!, aName, aNameEnd);
        if (aTree) this.diff(this.readTree(a!, aOid), null, t.childDir(dir, name), out);
        else out.push(t.childFile(dir, name));
        i = aOid + 20; needA = true;
      } else if (cmp > 0) {
        // only in the old tree: deleted (a deletion is a touch)
        const name = nameAt(b!, bName, bNameEnd);
        if (bTree) this.diff(null, this.readTree(b!, bOid), t.childDir(dir, name), out);
        else out.push(t.childFile(dir, name));
        j = bOid + 20; needB = true;
      } else {
        let same = aMode === bMode;
        if (same) for (let k = 0; k < 20; k++) if (a![aOid + k] !== b![bOid + k]) { same = false; break; }
        if (!same) {
          const name = nameAt(a!, aName, aNameEnd);
          if (aTree) this.diff(this.readTree(a!, aOid), this.readTree(b!, bOid), t.childDir(dir, name), out);
          else out.push(t.childFile(dir, name));
        }
        i = aOid + 20; needA = true;
        j = bOid + 20; needB = true;
      }
    }
  }
}

/** Number of distinct authors a chunk can tell apart per path (the pair key packs both into a double). */
const AUTHOR_SPAN = 1 << 20;

/** Diff every commit of a chunk and total the touched paths. Nothing is kept once a commit is done. */
export function runChunk(odb: ObjectDb, table: PathTable, input: ChunkInput): ChunkOutput {
  const startedAt = Date.now();
  const differ = new TreeDiffer(odb, table);
  const skipMerges = input.merges === 'skip';

  // chunk-local slots for the paths and authors that occur
  const slotOfPath = new Map<number, number>();
  const pathIds: number[] = [];
  const commits: number[] = [];
  const last: number[] = [];
  const first: number[] = [];
  const lastAuthor: number[] = [];
  const lastPrefix: number[] = [];
  const pairs = new Map<number, number>(); // path slot × AUTHOR_SPAN + author slot → commits
  const slotOfAuthor = new Map<number, number>();
  const authorIds: number[] = [];
  const authorCommits: number[] = [];
  const authorLast: number[] = [];
  const localAuthors: string[] = [];
  const localIds = new Map<string, number>();

  const touched: number[] = [];
  let mergesSkipped = 0, missing = 0;
  for (const c of input.commits) {
    if (c.isMerge && skipMerges) { mergesSkipped++; continue; }
    let author = c.author;
    let time = c.time;
    if (author < 0) {
      // planned from the commit-graph, which has no author: read the commit itself
      const obj = odb.readHex(c.oid);
      const head = obj && obj.type === T_COMMIT ? parseCommitHeader(obj.data) : null;
      if (!head) { missing++; continue; }
      let local = localIds.get(head.ident);
      if (local === undefined) {
        local = -(localAuthors.length + 1);
        localAuthors.push(head.ident);
        localIds.set(head.ident, local);
      }
      author = local;
      time = head.authorTime;
    }
    touched.length = 0;
    if (!c.boundary) {
      try {
        differ.changed(c.tree, c.parentTree, touched);
      } catch (e) {
        if (!(e instanceof MissingObjectError)) throw e;
        missing++;
        continue;
      }
    }
    let a = slotOfAuthor.get(author);
    if (a === undefined) {
      a = authorIds.length;
      if (a >= AUTHOR_SPAN) throw new Error('history.chunk: too many authors in one chunk');
      slotOfAuthor.set(author, a);
      authorIds.push(author);
      authorCommits.push(0);
      authorLast.push(-Infinity);
    }
    authorCommits[a]++;
    if (time > authorLast[a]) authorLast[a] = time;
    const prefix = parseInt(c.oid.slice(0, 8), 16);
    for (let k = 0; k < touched.length; k++) {
      const id = touched[k];
      let s = slotOfPath.get(id);
      if (s === undefined) {
        s = pathIds.length;
        slotOfPath.set(id, s);
        pathIds.push(id);
        commits.push(0);
        last.push(-Infinity);
        first.push(Infinity);
        lastAuthor.push(author);
        lastPrefix.push(0);
      }
      commits[s]++;
      if (time > last[s] || (time === last[s] && prefix > lastPrefix[s])) {
        last[s] = time;
        lastAuthor[s] = author;
        lastPrefix[s] = prefix;
      }
      if (time < first[s]) first[s] = time;
      const key = s * AUTHOR_SPAN + a;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }

  const authorPairs = new Int32Array(pairs.size * 3);
  let p = 0;
  for (const [key, n] of pairs) {
    const a = key % AUTHOR_SPAN;
    authorPairs[p++] = (key - a) / AUTHOR_SPAN;
    authorPairs[p++] = authorIds[a];
    authorPairs[p++] = n;
  }
  return {
    paths: pathIds.map((id) => table.paths[id]),
    commits: Uint32Array.from(commits),
    last: Float64Array.from(last),
    first: Float64Array.from(first),
    lastAuthor: Int32Array.from(lastAuthor),
    lastOidPrefix: Uint32Array.from(lastPrefix),
    authorPairs,
    authorIds: Int32Array.from(authorIds),
    authorCommits: Uint32Array.from(authorCommits),
    authorLast: Float64Array.from(authorLast),
    localAuthors,
    walked: input.commits.length,
    mergesSkipped,
    missing,
    startedAt,
    endedAt: Date.now(),
  };
}

/** The buffers of a chunk's output, to transfer instead of copy. */
export function chunkBuffers(o: ChunkOutput): ArrayBuffer[] {
  return [o.commits, o.last, o.first, o.lastAuthor, o.lastOidPrefix, o.authorPairs, o.authorIds, o.authorCommits, o.authorLast]
    .map((a) => a.buffer as ArrayBuffer);
}
