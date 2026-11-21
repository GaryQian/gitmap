// Page cache over large files (packs). In a browser every underlying read is a cross-process call
// costing about a quarter of a millisecond whatever its size (spikes/git/RESULTS.md), so small random
// reads are served from fixed-size pages and the number of readAt calls stays low.
import type { GitFs } from '../contracts/git';

export interface IoStats {
  /** Underlying GitFs.readAt calls. */
  calls: number;
  bytes: number;
}

/**
 * Pages shared by every pack of one repository, with a two-generation eviction: when the young
 * generation fills, it becomes the old one and the previous old generation is dropped whole.
 * (A Map-order LRU that evicts one key at a time was measured to take half the walk time in V8.)
 */
export class PageCache {
  private young = new Map<number, Uint8Array>();
  private old = new Map<number, Uint8Array>();
  private readonly perGeneration: number;
  constructor(readonly pageBytes: number, budgetBytes: number) {
    this.perGeneration = Math.max(1, Math.floor(budgetBytes / Math.max(1, pageBytes) / 2));
  }
  get(key: number): Uint8Array | undefined {
    const p = this.young.get(key);
    if (p) return p;
    const o = this.old.get(key);
    if (o) this.set(key, o);
    return o;
  }
  set(key: number, page: Uint8Array): void {
    this.young.set(key, page);
    if (this.young.size >= this.perGeneration) {
      this.old = this.young;
      this.young = new Map();
    }
  }
}

const FILE_KEY = 2 ** 32;

/**
 * Random access to one file through the page cache. Returned arrays may be views into cached pages
 * and must not be mutated.
 */
export class PagedFile {
  constructor(
    private fs: GitFs,
    readonly path: string,
    readonly fileSize: number,
    private cache: PageCache,
    /** Distinguishes this file's pages in the shared cache. */
    private fileId: number,
    private io: IoStats,
  ) {}

  private raw(off: number, len: number): Uint8Array {
    this.io.calls++;
    this.io.bytes += len;
    return this.fs.readAt(this.path, off, len);
  }

  private page(i: number): Uint8Array {
    const key = this.fileId * FILE_KEY + i;
    let p = this.cache.get(key);
    if (!p) {
      const ps = this.cache.pageBytes;
      const off = i * ps;
      p = this.raw(off, Math.min(ps, this.fileSize - off));
      this.cache.set(key, p);
    }
    return p;
  }

  read(off: number, len: number): Uint8Array {
    const ps = this.cache.pageBytes;
    if (ps <= 0 || len >= ps * 2) return this.raw(off, len);
    const first = Math.floor(off / ps);
    const last = Math.floor((off + len - 1) / ps);
    if (first === last) {
      const s = off - first * ps;
      return this.page(first).subarray(s, s + len);
    }
    const out = new Uint8Array(len);
    let o = 0;
    for (let i = first; i <= last; i++) {
      const p = this.page(i);
      const s = i === first ? off - first * ps : 0;
      const e = Math.min(p.length, off + len - i * ps);
      out.set(p.subarray(s, e), o);
      o += e - s;
    }
    return out;
  }
}
