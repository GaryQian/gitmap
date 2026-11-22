// Reader for objects/info/commit-graph (gitformat-commit-graph(5)): parents, root tree and commit
// time of every commit it lists, without inflating commit objects. It has no author, so chunks still
// read the commit. Optional: a missing, split (chained) or unreadable file means "read the objects".
import type { GitFs } from '../contracts/git';
import { hexToBytes, toHex } from '../git';

const PATH = 'objects/info/commit-graph';
const SIGNATURE = 0x43475048; // 'CGPH'
const OIDF = 0x4f494446, OIDL = 0x4f49444c, CDAT = 0x43444154, EDGE = 0x45444745;
const NO_PARENT = 0x70000000;
const LAST_EDGE = 0x80000000;
const HASH = 20;
const CDAT_ROW = HASH + 16;
/** A graph larger than this is not loaded (it is read whole, once per worker that plans). */
const MAX_BYTES = 512 * 1024 * 1024;

export interface GraphCommit { tree: string; parents: string[]; date: number }

export class CommitGraph {
  private constructor(
    private data: Uint8Array,
    private dv: DataView,
    /** Number of commits listed. */
    readonly count: number,
    private fanoutAt: number,
    private oidAt: number,
    private cdatAt: number,
    private edgeAt: number,
    private edgeEnd: number,
  ) {}

  /** The repository's commit-graph, or null when there is none this reader understands. */
  static open(fs: GitFs): CommitGraph | null {
    try {
      const size = fs.size(PATH);
      if (size < 8 + 12 || size > MAX_BYTES) return null;
      return CommitGraph.parse(fs.readAt(PATH, 0, size));
    } catch { return null; }
  }

  static parse(data: Uint8Array): CommitGraph | null {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < 20 || dv.getUint32(0) !== SIGNATURE) return null;
    // version 1, SHA-1, and no base graphs (a split graph's parents point into other files)
    if (data[4] !== 1 || data[5] !== 1 || data[7] !== 0) return null;
    const chunks = data[6];
    if (data.length < 8 + (chunks + 1) * 12) return null;
    const at = new Map<number, { start: number; end: number }>();
    for (let i = 0; i < chunks; i++) {
      const row = 8 + i * 12;
      const start = dv.getUint32(row + 4) * 4294967296 + dv.getUint32(row + 8);
      const end = dv.getUint32(row + 16) * 4294967296 + dv.getUint32(row + 20);
      if (start > end || end > data.length) return null;
      at.set(dv.getUint32(row), { start, end });
    }
    const fanout = at.get(OIDF), oids = at.get(OIDL), cdat = at.get(CDAT), edge = at.get(EDGE);
    if (!fanout || !oids || !cdat || fanout.end - fanout.start < 1024) return null;
    const count = dv.getUint32(fanout.start + 255 * 4);
    if (oids.end - oids.start < count * HASH || cdat.end - cdat.start < count * CDAT_ROW) return null;
    return new CommitGraph(data, dv, count, fanout.start, oids.start, cdat.start, edge ? edge.start : 0, edge ? edge.end : 0);
  }

  /** Position of a commit in the graph, or −1. */
  private find(oid: Uint8Array): number {
    const b0 = oid[0];
    let lo = b0 === 0 ? 0 : this.dv.getUint32(this.fanoutAt + (b0 - 1) * 4);
    let hi = this.dv.getUint32(this.fanoutAt + b0 * 4) - 1;
    const d = this.data;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const base = this.oidAt + mid * HASH;
      let c = 0;
      for (let i = 1; i < HASH; i++) {
        c = d[base + i] - oid[i];
        if (c !== 0) break;
      }
      if (c === 0) return mid;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Parents, tree and commit time of a commit; null when the graph does not list it. */
  lookup(oidHex: string): GraphCommit | null {
    const pos = this.find(hexToBytes(oidHex));
    if (pos < 0) return null;
    const row = this.cdatAt + pos * CDAT_ROW;
    const dv = this.dv;
    const p1 = dv.getUint32(row + HASH);
    const p2 = dv.getUint32(row + HASH + 4);
    const parents: string[] = [];
    const add = (p: number): boolean => {
      if (p >= this.count) return false;
      parents.push(toHex(this.data, this.oidAt + p * HASH));
      return true;
    };
    if (p1 !== NO_PARENT && !add(p1)) return null;
    if (p2 !== NO_PARENT) {
      if (p2 & LAST_EDGE) {
        // an octopus merge: parents from the second on are listed in the EDGE chunk
        for (let e = this.edgeAt + (p2 & 0x7fffffff) * 4; ; e += 4) {
          if (!this.edgeAt || e + 4 > this.edgeEnd) return null;
          const v = dv.getUint32(e);
          if (!add(v & 0x7fffffff)) return null;
          if (v & LAST_EDGE) break;
        }
      } else if (!add(p2)) return null;
    }
    // 30 bits of generation number, then 34 bits of commit time
    const date = (dv.getUint32(row + HASH + 8) & 3) * 4294967296 + dv.getUint32(row + HASH + 12);
    return { tree: toHex(this.data, row), parents, date };
  }
}
