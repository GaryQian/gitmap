// History walker: HEAD -> commits newest-first (by committer time, all parents, each once),
// diff each commit's tree vs its FIRST parent's tree (descending only into differing
// subtrees, never reading blobs), aggregate per-file facts.
import { GitFs, now } from './fs.ts';
import { Odb, OdbOptions, T_COMMIT, T_TAG, T_TREE, asciiHexToBytes, hexToBytes, toHex } from './odb.ts';

const td = new TextDecoder();
function str(b: Uint8Array, s: number, e: number): string {
  let ascii = true;
  for (let i = s; i < e; i++) if (b[i] > 127) { ascii = false; break; }
  if (!ascii) return td.decode(b.subarray(s, e));
  if (e - s < 64) {
    let r = '';
    for (let i = s; i < e; i++) r += String.fromCharCode(b[i]);
    return r;
  }
  return td.decode(b.subarray(s, e));
}

export function resolveHead(fs: GitFs): string {
  const read = (p: string) => {
    const n = fs.size(p);
    return n < 0 ? null : td.decode(fs.readAt(p, 0, n)).trim();
  };
  let head = read('HEAD');
  if (!head) throw new Error('no HEAD');
  for (let depth = 0; head.startsWith('ref: ') && depth < 10; depth++) {
    const ref = head.slice(5).trim();
    let v = read(ref);
    if (!v) {
      const packed = read('packed-refs') ?? '';
      for (const line of packed.split('\n')) {
        if (line.length >= 41 && line[0] !== '#' && line[0] !== '^' && line.slice(41).trim() === ref) {
          v = line.slice(0, 40);
          break;
        }
      }
    }
    if (!v) throw new Error('unresolvable ref ' + ref);
    head = v;
  }
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('bad HEAD ' + head);
  return head;
}

export interface CommitInfo {
  oid: string;
  tree: Uint8Array;
  parents: Uint8Array[];
  authorTime: number;
  commitTime: number;
  author: number; // interned author id
}

export interface Checkpoint {
  commits: number;
  ms: number;
  coverage: number; // fraction of HEAD files with a last-modified time
  rssMB: number;
}

export interface WalkOptions extends OdbOptions {
  maxCommits?: number;
  timeLimitMs?: number;
  coChangeMaxFiles?: number; // default 50; 0 disables co-change
  checkpoints?: number[];
  onProgress?: (commits: number, ms: number) => void;
  progressEvery?: number;
}

export class History {
  odb: Odb;
  // per-path facts (index = path id)
  paths: string[] = [];
  pathIds = new Map<string, number>();
  count: number[] = [];
  last: number[] = [];
  first: number[] = [];
  authorCounts = new Map<number, number>(); // pathId * 2^20 + authorId -> commits
  authors: string[] = []; // "Name <email>" keyed by email
  authorIds = new Map<string, number>();
  coChange = new Map<number, number>(); // lo * 2^22 + hi -> commits
  coChangeSkipped = 0;
  // HEAD tracking for coverage
  headFiles = new Set<number>();
  headCovered = 0;
  // stats
  commitsWalked = 0;
  treesRead = 0;
  treeBytes = 0;
  filesTouched = 0;
  commitReadMs = 0;
  diffMs = 0;
  headTreeMs = 0;
  checkpoints: Checkpoint[] = [];
  stoppedBy: 'done' | 'maxCommits' | 'timeLimit' = 'done';
  peakRssMB = 0;
  peakHeapMB = 0;
  peakArrayBuffersMB = 0;
  private treeOf = new Map<string, Uint8Array>();

  constructor(private fs: GitFs, private opts: WalkOptions = {}) {
    this.odb = new Odb(fs, opts);
  }

  // directory interning: paths are resolved per directory level from short names, so no
  // full-path strings are built or hashed on the hot path (only once per new path).
  private dirPath: string[] = [''];
  private dirDirs: (Map<string, number> | undefined)[] = [undefined];
  private dirFiles: (Map<string, number> | undefined)[] = [undefined];
  private childDir(dir: number, name: string): number {
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
  private childFile(dir: number, name: string): number {
    let m = this.dirFiles[dir];
    if (!m) this.dirFiles[dir] = m = new Map();
    let id = m.get(name);
    if (id === undefined) {
      id = this.pathId(this.dirPath[dir] + name);
      m.set(name, id);
    }
    return id;
  }

  private pathId(p: string): number {
    let id = this.pathIds.get(p);
    if (id === undefined) {
      id = this.paths.length;
      this.pathIds.set(p, id);
      this.paths.push(p);
      this.count.push(0);
      this.last.push(-Infinity);
      this.first.push(Infinity);
    }
    return id;
  }

  readCommit(oidHex: string): CommitInfo {
    let obj = this.odb.read(hexToBytes(oidHex));
    while (obj.type === T_TAG) {
      // annotated tag: "object <hex>"
      obj = this.odb.read(asciiHexToBytes(obj.data, 7));
    }
    if (obj.type !== T_COMMIT) throw new Error('not a commit ' + oidHex);
    const b = obj.data;
    let pos = 0;
    let tree: Uint8Array | null = null;
    const parents: Uint8Array[] = [];
    let authorTime = 0, commitTime = 0, author = -1;
    while (pos < b.length) {
      let e = pos;
      while (e < b.length && b[e] !== 10) e++;
      if (e === pos) break; // end of headers
      const c0 = b[pos];
      if (c0 === 116 /* t */ && b[pos + 4] === 32) tree = asciiHexToBytes(b, pos + 5);
      else if (c0 === 112 /* p */ && b[pos + 6] === 32) parents.push(asciiHexToBytes(b, pos + 7));
      else if (c0 === 97 /* a */ && b[pos + 6] === 32) {
        // author Name <email> 1234567890 +0000
        let lt = pos + 7;
        while (lt < e && b[lt] !== 60) lt++;
        let gt = lt;
        while (gt < e && b[gt] !== 62) gt++;
        const email = str(b, lt + 1, gt);
        let id = this.authorIds.get(email);
        if (id === undefined) {
          id = this.authors.length;
          this.authorIds.set(email, id);
          this.authors.push(str(b, pos + 7, Math.max(pos + 7, lt - 1)) + ' <' + email + '>');
        }
        author = id;
        authorTime = parseTime(b, gt + 2, e);
      } else if (c0 === 99 /* c */ && b[pos + 9] === 32 && b[pos + 1] === 111) {
        let gt = e;
        while (gt > pos && b[gt] !== 62) gt--;
        commitTime = parseTime(b, gt + 2, e);
        break; // nothing after committer is needed
      }
      pos = e + 1;
    }
    if (!tree) throw new Error('commit without tree ' + oidHex);
    return { oid: oidHex, tree, parents, authorTime, commitTime, author };
  }

  private readTree(oid: Uint8Array, at: number): Uint8Array {
    const o = this.odb.read(oid, at);
    if (o.type !== T_TREE) throw new Error('expected tree ' + toHex(oid, at));
    this.treesRead++;
    this.treeBytes += o.data.length;
    return o.data;
  }

  /** diff tree a (new) vs b (old); push changed file paths (ids) to out */
  diff(a: Uint8Array | null, b: Uint8Array | null, dir: number, out: number[]) {
    const al = a ? a.length : 0, bl = b ? b.length : 0;
    let i = 0, j = 0;
    // current entry fields
    let aMode = 0, aName = 0, aNameEnd = 0, aOid = 0, aTree = false;
    let bMode = 0, bName = 0, bNameEnd = 0, bOid = 0, bTree = false;
    let needA = true, needB = true;
    for (;;) {
      if (needA && i < al) {
        let m = 0, p = i;
        while (a![p] !== 32) m = m * 8 + (a![p++] - 48);
        aMode = m; aName = p + 1; p = aName;
        while (a![p] !== 0) p++;
        aNameEnd = p; aOid = p + 1; aTree = m === 0o40000;
        needA = false;
      }
      if (needB && j < bl) {
        let m = 0, p = j;
        while (b![p] !== 32) m = m * 8 + (b![p++] - 48);
        bMode = m; bName = p + 1; p = bName;
        while (b![p] !== 0) p++;
        bNameEnd = p; bOid = p + 1; bTree = m === 0o40000;
        needB = false;
      }
      const haveA = i < al, haveB = j < bl;
      if (!haveA && !haveB) return;
      let cmp: number;
      if (!haveA) cmp = 1;
      else if (!haveB) cmp = -1;
      else {
        // git base_name_compare: directories compare as if suffixed with '/'
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
        const name = str(a!, aName, aNameEnd);
        if (aTree) this.diff(this.readTree(a!, aOid), null, this.childDir(dir, name), out);
        else out.push(this.childFile(dir, name));
        i = aOid + 20; needA = true;
      } else if (cmp > 0) {
        const name = str(b!, bName, bNameEnd);
        if (bTree) this.diff(null, this.readTree(b!, bOid), this.childDir(dir, name), out);
        else out.push(this.childFile(dir, name));
        j = bOid + 20; needB = true;
      } else {
        let same = aMode === bMode;
        if (same) for (let k = 0; k < 20; k++) if (a![aOid + k] !== b![bOid + k]) { same = false; break; }
        if (!same) {
          const name = str(a!, aName, aNameEnd);
          if (aTree) this.diff(this.readTree(a!, aOid), this.readTree(b!, bOid), this.childDir(dir, name), out);
          else out.push(this.childFile(dir, name));
        }
        i = aOid + 20; needA = true;
        j = bOid + 20; needB = true;
      }
    }
  }

  private sampleMem() {
    const proc = (globalThis as any).process; // Node-only instrumentation
    if (!proc?.memoryUsage) return;
    const m = proc.memoryUsage();
    const rss = m.rss / 1048576, heap = m.heapUsed / 1048576;
    if (rss > this.peakRssMB) this.peakRssMB = rss;
    if (heap > this.peakHeapMB) this.peakHeapMB = heap;
    const ab = m.arrayBuffers / 1048576;
    if (ab > this.peakArrayBuffersMB) this.peakArrayBuffersMB = ab;
  }

  run(): void {
    const o = this.opts;
    const maxCommits = o.maxCommits ?? Infinity;
    const timeLimit = o.timeLimitMs ?? Infinity;
    const coMax = o.coChangeMaxFiles ?? 50;
    const cps = (o.checkpoints ?? [100, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000]).slice().sort((x, y) => x - y);
    let cpi = 0;
    const t0 = now();

    const headOid = resolveHead(this.fs);
    const head = this.readCommit(headOid);
    // HEAD file list (for coverage); in the app this comes from .git/index instead.
    const th = now();
    const headList: number[] = [];
    this.diff(this.readTree(head.tree, 0), null, 0, headList);
    for (const id of headList) this.headFiles.add(id);
    this.headTreeMs = now() - th;

    const heap: CommitInfo[] = [];
    const seen = new Set<string>();
    const push = (c: CommitInfo) => {
      heap.push(c);
      let k = heap.length - 1;
      while (k > 0) {
        const pk = (k - 1) >> 1;
        if (heap[pk].commitTime >= heap[k].commitTime) break;
        [heap[pk], heap[k]] = [heap[k], heap[pk]];
        k = pk;
      }
    };
    const pop = (): CommitInfo => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let m = k;
          if (l < heap.length && heap[l].commitTime > heap[m].commitTime) m = l;
          if (r < heap.length && heap[r].commitTime > heap[m].commitTime) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    seen.add(headOid);
    this.treeOf.set(headOid, head.tree);
    push(head);
    const touched: number[] = [];
    const every = o.progressEvery ?? 5000;

    while (heap.length) {
      if (this.commitsWalked >= maxCommits) { this.stoppedBy = 'maxCommits'; break; }
      if (now() - t0 > timeLimit) { this.stoppedBy = 'timeLimit'; break; }
      const c = pop();
      const tc = now();
      for (const pb of c.parents) {
        const ph = toHex(pb);
        if (seen.has(ph)) continue;
        seen.add(ph);
        const pc = this.readCommit(ph);
        this.treeOf.set(ph, pc.tree);
        push(pc);
      }
      const t1 = now();
      this.commitReadMs += t1 - tc;
      touched.length = 0;
      const parentTree = c.parents.length ? this.treeOf.get(toHex(c.parents[0]))! : null;
      if (!parentTree || !eq20(parentTree, c.tree)) {
        this.diff(this.readTree(c.tree, 0), parentTree ? this.readTree(parentTree, 0) : null, 0, touched);
      }
      this.diffMs += now() - t1;
      // aggregate
      const at = c.authorTime;
      const akey = c.author;
      for (let k = 0; k < touched.length; k++) {
        const id = touched[k];
        if (this.count[id]++ === 0 && this.headFiles.has(id)) this.headCovered++;
        if (at > this.last[id]) this.last[id] = at;
        if (at < this.first[id]) this.first[id] = at;
        const ak = id * 1048576 + akey;
        this.authorCounts.set(ak, (this.authorCounts.get(ak) ?? 0) + 1);
      }
      this.filesTouched += touched.length;
      if (coMax > 0 && touched.length >= 2) {
        if (touched.length > coMax) this.coChangeSkipped++;
        else {
          for (let x = 0; x < touched.length; x++)
            for (let y = x + 1; y < touched.length; y++) {
              const p = touched[x], q = touched[y];
              const key = p < q ? p * 4194304 + q : q * 4194304 + p;
              this.coChange.set(key, (this.coChange.get(key) ?? 0) + 1);
            }
        }
      }
      this.commitsWalked++;
      const n = this.commitsWalked;
      if (n % 1000 === 0) this.sampleMem();
      if (o.onProgress && n % every === 0) o.onProgress(n, now() - t0);
      while (cpi < cps.length && n === cps[cpi]) {
        this.sampleMem();
        this.checkpoints.push({
          commits: n,
          ms: now() - t0,
          coverage: this.headFiles.size ? this.headCovered / this.headFiles.size : 0,
          rssMB: (globalThis as any).process?.memoryUsage ? (globalThis as any).process.memoryUsage().rss / 1048576 : 0,
        });
        cpi++;
      }
    }
    this.sampleMem();
  }
}

function eq20(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < 20; i++) if (a[i] !== b[i]) return false;
  return true;
}

function parseTime(b: Uint8Array, s: number, e: number): number {
  let v = 0;
  let neg = false;
  let p = s;
  if (b[p] === 45) { neg = true; p++; }
  while (p < e && b[p] >= 48 && b[p] <= 57) v = v * 10 + (b[p++] - 48);
  return neg ? -v : v;
}
