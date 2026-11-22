// Reducing a partition to the wanted number of communities (PLAN.md §6.6): the smallest community
// is merged into its most-connected neighbour, by summed edge weight, until at most `target` remain
// and none is smaller than `minSize`. A community with no outside edges goes to the one sharing the
// most directory ancestry, else to the smallest other.
import { mergeScore } from './balance';
import type { EdgeList } from './graph';

export interface Partition {
  /** Community per node, numbered 0..count-1 in order of first appearance over the nodes. */
  labels: Int32Array;
  count: number;
}

/** Number of communities in a labelling whose labels are 0..count-1. */
export function labelCount(labels: Int32Array): number {
  let count = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] >= count) count = labels[i] + 1;
  return count;
}

/** Total node size per community. */
export function communitySizes(labels: Int32Array, nodeSize: ArrayLike<number>): Float64Array {
  const size = new Float64Array(labelCount(labels));
  for (let i = 0; i < labels.length; i++) size[labels[i]] += nodeSize[i];
  return size;
}

/**
 * @param labels   community per node, 0..count-1
 * @param nodeSize files per node (whole numbers; 0 for directory hubs, so a hub-only community always merges away)
 * @param pathOf   path of a file node, undefined for a hub; read only when a community has no outside edges
 */
export function mergeDown(
  labels: Int32Array,
  edges: EdgeList,
  nodeSize: ArrayLike<number>,
  target: number,
  minSize: number,
  pathOf: (node: number) => string | undefined,
  /**
   * Bias against giants, 0..1 (balance.ts). Above 0 the partner is the neighbour most connected for
   * its size (balance.ts mergeScore) instead of the most connected outright, and `target` is compared
   * with the effective count (Σsize)²/Σsize², so merging stops while small communities still stand
   * beside a large one. At 0 this is the plain rule.
   */
  sizeBias = 0,
  /** With a bias, more than `target` communities can remain; never more than this many. */
  maxCount = Infinity,
): Partition {
  const size = communitySizes(labels, nodeSize);
  const count = size.length;
  const adj: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  for (let e = 0; e < edges.count; e++) {
    const ca = labels[edges.a[e]], cb = labels[edges.b[e]];
    if (ca === cb) continue;
    adj[ca].set(cb, (adj[ca].get(cb) ?? 0) + edges.w[e]);
    adj[cb].set(ca, (adj[cb].get(ca) ?? 0) + edges.w[e]);
  }

  const alive = new Uint8Array(count).fill(1);
  const parent = new Int32Array(count);
  const heap = new MinHeap();
  for (let c = 0; c < count; c++) { parent[c] = c; heap.push(size[c] * count + c); }
  const find = (c: number): number => { while (parent[c] !== c) c = parent[c]; return c; };
  /** Pops the smallest live community (ties: lowest index); -1 when none is left. Stale keys are skipped. */
  const smallest = (): number => {
    for (;;) {
      const key = heap.pop();
      if (key === undefined) return -1;
      const c = key % count;
      if (alive[c] && Math.floor(key / count) === size[c]) return c;
    }
  };

  const floor = Math.max(1, minSize);
  const bias = Math.min(1, Math.max(0, sizeBias));
  // The running Σsize², for the effective count.
  let totalSize = 0, sumSq = 0;
  for (let c = 0; c < count; c++) { totalSize += size[c]; sumSq += size[c] * size[c]; }
  /** Communities as `target` counts them: plain at bias 0, effective at 1. */
  const counted = (liveNow: number): number =>
    bias === 0 || sumSq <= 0 ? liveNow : (1 - bias) * liveNow + bias * ((totalSize * totalSize) / sumSq);
  let live = count;
  let ancestry: Ancestry | null = null;
  while (live > 1) {
    const s = smallest();
    if (s < 0 || (size[s] >= floor && counted(live) <= target && live <= maxCount)) break;

    // A crumb may join anything; a full community only what keeps the result within the size limit.
    // The best-connected neighbour; with a bias, best connected for its size, so a giant needs
    // proportionally more connections than a small neighbour to be chosen.
    let t = -1, best = 0;
    for (const [c, w] of adj[s]) {
      const score = mergeScore(w, size[c], bias);
      if (score > best || (score === best && c < t)) { t = c; best = score; }
    }
    if (t < 0) {
      ancestry ??= new Ancestry(labels, alive, find, pathOf);
      t = ancestry.partner(s, size);
      if (t < 0) t = smallest();
      if (t < 0) break;
    }

    for (const [c, w] of adj[s]) {
      if (c === t) continue;
      adj[c].delete(s);
      adj[c].set(t, (adj[c].get(t) ?? 0) + w);
      adj[t].set(c, (adj[t].get(c) ?? 0) + w);
    }
    adj[t].delete(s);
    adj[s].clear();
    sumSq += 2 * size[s] * size[t];
    size[t] += size[s];
    alive[s] = 0;
    parent[s] = t;
    live--;
    ancestry?.remove(s);
    heap.push(size[t] * count + t);
  }

  const dense = new Int32Array(count).fill(-1);
  const out = new Int32Array(labels.length);
  let k = 0;
  for (let i = 0; i < labels.length; i++) {
    const r = find(labels[i]);
    if (dense[r] < 0) dense[r] = k++;
    out[i] = dense[r];
  }
  return { labels: out, count: k };
}

/**
 * Directory ancestry between communities, for the ones no edge connects. Each community stands for
 * the deepest directory holding more than half of its files; live communities are kept in the order
 * of those directories, where the one sharing the most leading segments is always a neighbour.
 */
class Ancestry {
  private readonly dir: string[];
  private readonly prev: Int32Array;
  private readonly next: Int32Array;

  constructor(labels: Int32Array, alive: Uint8Array, find: (c: number) => number, pathOf: (node: number) => string | undefined) {
    const count = alive.length;
    const members: string[][] = Array.from({ length: count }, () => []);
    for (let i = 0; i < labels.length; i++) {
      const p = pathOf(i);
      if (p !== undefined) members[find(labels[i])].push(p);
    }
    this.dir = members.map((paths, c) => (alive[c] ? dominantDir(paths) : ''));
    const order: number[] = [];
    for (let c = 0; c < count; c++) if (alive[c]) order.push(c);
    const dir = this.dir;
    order.sort((x, y) => (dir[x] < dir[y] ? -1 : dir[x] > dir[y] ? 1 : x - y));
    this.prev = new Int32Array(count).fill(-1);
    this.next = new Int32Array(count).fill(-1);
    for (let k = 1; k < order.length; k++) { this.prev[order[k]] = order[k - 1]; this.next[order[k - 1]] = order[k]; }
  }

  /** The live community sharing the most leading directories with `c`; -1 when none shares any. */
  partner(c: number, size: Float64Array): number {
    const p = this.prev[c], n = this.next[c];
    const sp = p < 0 ? 0 : sharedSegments(this.dir[c], this.dir[p]);
    const sn = n < 0 ? 0 : sharedSegments(this.dir[c], this.dir[n]);
    if (sp === 0 && sn === 0) return -1;
    if (sp !== sn) return sp > sn ? p : n;
    return size[p] < size[n] || (size[p] === size[n] && p < n) ? p : n;
  }

  remove(c: number): void {
    const p = this.prev[c], n = this.next[c];
    if (p >= 0) this.next[p] = n;
    if (n >= 0) this.prev[n] = p;
  }
}

/** The deepest directory ('a/b/', '' for the root) that holds more than half of `paths`. */
function dominantDir(paths: readonly string[]): string {
  let prefix = '';
  for (;;) {
    const counts = new Map<string, number>();
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue;
      const cut = p.indexOf('/', prefix.length);
      if (cut < 0) continue;
      const seg = p.slice(prefix.length, cut);
      counts.set(seg, (counts.get(seg) ?? 0) + 1);
    }
    let best = '', top = 0;
    for (const [seg, c] of counts) if (c > top || (c === top && seg < best)) { best = seg; top = c; }
    if (top * 2 <= paths.length) return prefix;
    prefix += best + '/';
  }
}

/** Leading directories two 'a/b/' style paths have in common. */
function sharedSegments(x: string, y: string): number {
  let shared = 0;
  for (let i = 0; i < x.length && i < y.length && x[i] === y[i]; i++) if (x[i] === '/') shared++;
  return shared;
}

/** Binary min-heap of numbers. */
class MinHeap {
  private readonly keys: number[] = [];

  push(key: number): void {
    const h = this.keys;
    let i = h.length;
    h.push(key);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (h[up] <= key) break;
      h[i] = h[up];
      i = up;
    }
    h[i] = key;
  }

  pop(): number | undefined {
    const h = this.keys;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0 && last !== undefined) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= h.length) break;
        if (child + 1 < h.length && h[child + 1] < h[child]) child++;
        if (h[child] >= last) break;
        h[i] = h[child];
        i = child;
      }
      h[i] = last;
    }
    return top;
  }
}
