// The clustering graph (PLAN.md §6.6): undirected and weighted, built for community detection only.
// The model's edges are not touched.
//
//   symmetrise     w(u,v) = w(u→v) + w(v→u), each direction being weight × confidence
//   hub damping    an edge into a unit is divided by log2(1 + that unit's in-degree), so one logging
//                  utility does not glue the repo into a single city
//   directories    weak ties (clustering.directoryAffinity) that make a file with no code edges follow
//                  its folder, and a folder with no code at all follow the directory tree; see
//                  directoryAffinity below. Linear in files. Directory hubs exist in this graph only.
import type { Config } from '../../config';
import { hash32 } from '../../shared';
import type { UnitEdges } from '../edges';
import { comparePaths } from '../order';
import type { UnitTable } from '../units';

/** Undirected weighted edges, one per node pair, no self-loops. */
export interface EdgeList {
  count: number;
  a: Int32Array;
  b: Int32Array;
  w: Float64Array;
}

export interface ClusterGraph extends EdgeList {
  /** Unit nodes first, in path order whatever order the UnitTable is in; directory hubs after them. */
  nodes: number;
  units: number;
  /** UnitTable index per unit node. */
  unitOf: Int32Array;
  /** Unit id (path) per unit node. */
  paths: string[];
  /** Directory per hub ('' for the repo root): hub k is node `units + k`. */
  hubDirs: string[];
  /** Files per node: the unit's file count, 0 for a hub. */
  size: Float64Array;
}

export function buildClusterGraph(units: UnitTable, edges: UnitEdges, cfg: Config['clustering']): ClusterGraph {
  const n = units.count;

  // Nodes in path order.
  const unitOf = new Int32Array(n);
  let sorted = true;
  for (let u = 0; u < n; u++) {
    unitOf[u] = u;
    if (u > 0 && units.ids[u - 1] >= units.ids[u]) sorted = false;
  }
  if (!sorted) unitOf.sort((x, y) => comparePaths(units.ids[x], units.ids[y]));
  const nodeOf = new Int32Array(n);
  const paths = new Array<string>(n);
  for (let i = 0; i < n; i++) { nodeOf[unitOf[i]] = i; paths[i] = units.ids[unitOf[i]]; }

  // Directed edges as unordered node pairs, damped.
  const m = edges.count;
  const inDegree = new Int32Array(n);
  for (let e = 0; e < m; e++) if (edges.src[e] !== edges.dst[e]) inDegree[edges.dst[e]]++;
  const lo = new Int32Array(m);
  const hi = new Int32Array(m);
  const dw = new Float64Array(m);
  let pairs = 0;
  for (let e = 0; e < m; e++) {
    const s = nodeOf[edges.src[e]], d = nodeOf[edges.dst[e]];
    let w = edges.weight[e] * edges.confidence[e];
    if (s === d || !(w > 0)) continue;
    if (cfg.hubDamping) w /= Math.log2(1 + inDegree[edges.dst[e]]);
    lo[pairs] = s < d ? s : d; hi[pairs] = s < d ? d : s; dw[pairs] = w;
    pairs++;
  }

  // Sorted by (lo, hi) so both directions of a pair meet, whatever order the edges came in.
  const order = countingSort(n, pairs, lo, countingSort(n, pairs, hi, null));
  let folded = 0;
  for (let k = 0; k < pairs; k++) {
    const e = order[k];
    if (k === 0 || lo[e] !== lo[order[k - 1]] || hi[e] !== hi[order[k - 1]]) folded++;
  }

  const fa = new Int32Array(folded);
  const fb = new Int32Array(folded);
  const fw = new Float64Array(folded);
  for (let j = 0, k = -1; j < pairs; j++) {
    const e = order[j];
    if (k < 0 || lo[e] !== fa[k] || hi[e] !== fb[k]) { k++; fa[k] = lo[e]; fb[k] = hi[e]; }
    fw[k] += dw[e];
  }

  const affinity = cfg.directoryAffinity > 0 ? directoryAffinity(n, paths, fa, fb) : { a: [], b: [], hubs: [] };
  const count = folded + affinity.a.length;
  const a = new Int32Array(count);
  const b = new Int32Array(count);
  const w = new Float64Array(count);
  a.set(fa); b.set(fb); w.set(fw);
  a.set(affinity.a, folded); b.set(affinity.b, folded); w.fill(cfg.directoryAffinity, folded);

  const nodes = n + affinity.hubs.length;
  const size = new Float64Array(nodes);
  for (let i = 0; i < n; i++) size[i] = Math.max(1, units.fileCount[unitOf[i]] || 0);
  return { count, a, b, w, nodes, units: n, unitOf, paths, hubDirs: affinity.hubs, size };
}

/**
 * Directory-affinity edges, linear in files. Hub node n + h stands for directory h.
 *   - A hub is tied to its parent directory's hub, and to the directory's files that have code
 *     edges; in a directory where no file has any, to its first file, and the files to one another
 *     in runs of path-order neighbours (so a large flat directory can divide; see balance.ts).
 *   - A file with no code edges, in a directory that has files with some, is tied to the nearest
 *     such file before and after it in path order, and to nothing else: orphans follow the code
 *     beside them and never band together against it.
 */
function directoryAffinity(n: number, paths: readonly string[], ea: Int32Array, eb: Int32Array): { a: number[]; b: number[]; hubs: string[] } {
  const connected = new Uint8Array(n);
  for (let e = 0; e < ea.length; e++) { connected[ea[e]] = 1; connected[eb[e]] = 1; }

  // Hubs, created as the path-ordered files reach them; a directory's ancestors all get one.
  const hubs = new Map<string, number>();
  const parent: number[] = [];
  const hubOf = (dir: string): number => {
    let h = hubs.get(dir);
    if (h !== undefined) return h;
    h = parent.length;
    hubs.set(dir, h);
    parent.push(-1);
    if (dir !== '') parent[h] = hubOf(parentDir(dir));
    return h;
  };
  const dirOf = new Int32Array(n);
  for (let i = 0; i < n; i++) dirOf[i] = hubOf(parentDir(paths[i]));
  const byDir = countingSort(parent.length, n, dirOf, null);

  const a: number[] = [];
  const b: number[] = [];
  const tie = (x: number, y: number) => { a.push(x); b.push(y); };
  for (let h = 0, k = 0; h < parent.length; h++) {
    const from = k;
    let anchors = 0;
    for (; k < n && dirOf[byDir[k]] === h; k++) anchors += connected[byDir[k]];
    let before = -1;
    let runHead = -1;
    // Run length for a directory with no code: the power of two nearest √n, so it changes only when
    // the directory grows or shrinks about fourfold.
    const run = Math.max(2, 2 ** Math.round(Math.log2(Math.sqrt(Math.max(1, k - from)))));
    for (let j = from, waiting = from; j < k; j++) {
      const file = byDir[j];
      if (anchors === 0) {
        // No code in this directory: its files are tied in runs of neighbours in path order. Each
        // run is a small star around its first file, the first files are linked in order, and the
        // first of all hangs from the hub. One star around the hub would be a single indivisible
        // community however many files it held (tensorflow has data directories of 1,500 files);
        // runs divide wherever the counts ask, and unlike one long chain they cost Louvain nothing
        // extra. Where a run starts is decided by the file's own name (a hash of its path, one start
        // in `run` on average), not by its position in the listing, so adding or removing a file
        // moves at most the boundaries next to it and an Update stays local.
        if (runHead < 0) { tie(file, n + h); runHead = file; }
        else if (hash32(paths[file]) % run === 0) { tie(file, runHead); runHead = file; }
        else tie(file, runHead);
      } else if (!connected[file]) { if (before >= 0) tie(file, before); } else {
        tie(file, n + h);
        for (; waiting < j; waiting++) if (!connected[byDir[waiting]]) tie(byDir[waiting], file);
        before = file;
        waiting = j + 1;
      }
    }
    if (parent[h] >= 0) tie(n + h, n + parent[h]);
  }
  const dirs = new Array<string>(parent.length);
  for (const [dir, h] of hubs) dirs[h] = dir;
  return { a, b, hubs: dirs };
}

/** 'a/b/c.ts' → 'a/b'; a root-level path → ''. */
function parentDir(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/** Stable sort of positions 0..m-1 (or of `prev`'s order) by key[position], keys in 0..buckets-1. */
function countingSort(buckets: number, m: number, key: Int32Array, prev: Int32Array | null): Int32Array {
  const start = new Int32Array(buckets + 1);
  for (let k = 0; k < m; k++) start[key[k] + 1]++;
  for (let c = 0; c < buckets; c++) start[c + 1] += start[c];
  const out = new Int32Array(m);
  for (let k = 0; k < m; k++) {
    const e = prev ? prev[k] : k;
    out[start[key[e]]++] = e;
  }
  return out;
}
