// Browser-portable file access abstraction for the git walker.
// The core only ever calls these three synchronous methods. In a browser worker:
//   readAt -> new FileReaderSync().readAsArrayBuffer(file.slice(off, off + len))
//   size   -> file.size of a File resolved (async) during setup, or -1
//   list   -> names collected (async) during setup from directory handles
// Paths are relative to the .git directory, '/'-separated.

export interface GitFs {
  readAt(path: string, offset: number, length: number): Uint8Array;
  size(path: string): number; // -1 when missing
  list(dir: string): string[]; // [] when missing
}

export interface IoStats {
  calls: number; // underlying readAt calls
  bytes: number;
  ms: number;
}

export const now: () => number =
  typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

/**
 * Page cache over a large file (pack). Small random reads are served from fixed-size
 * pages kept in an LRU, so the number of underlying readAt calls (each a File.slice +
 * FileReaderSync in the browser) stays low. Returned arrays may be views into cached
 * pages and must not be mutated.
 */
export class PagedFile {
  private pages = new Map<number, Uint8Array>();
  constructor(
    private fs: GitFs,
    readonly path: string,
    readonly fileSize: number,
    private io: IoStats,
    private pageSize = 65536,
    private maxPages = 512,
  ) {}

  private raw(off: number, len: number): Uint8Array {
    const t = now();
    const b = this.fs.readAt(this.path, off, len);
    this.io.ms += now() - t;
    this.io.calls++;
    this.io.bytes += len;
    return b;
  }

  private page(i: number): Uint8Array {
    let p = this.pages.get(i);
    if (p) {
      this.pages.delete(i);
      this.pages.set(i, p);
      return p;
    }
    const off = i * this.pageSize;
    p = this.raw(off, Math.min(this.pageSize, this.fileSize - off));
    this.pages.set(i, p);
    if (this.pages.size > this.maxPages) {
      this.pages.delete(this.pages.keys().next().value!);
    }
    return p;
  }

  read(off: number, len: number): Uint8Array {
    const ps = this.pageSize;
    if (ps === 0 || len >= ps * 2) return this.raw(off, len);
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
