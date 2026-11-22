// The clustering graph (PLAN.md §6.6): undirected and weighted, built for community detection only.
// The model's edges are not touched.
//
//   symmetrise     w(u,v) = w(u→v) + w(v→u), each direction being weight × confidence
//   hub damping    an edge into a unit is divided by log2(1 + that unit's in-degree), so one logging
//                  utility does not glue the repo into a single city
//   path bias      a code edge between files that sit close in the directory tree counts for more
//                  (clustering.pathBias × pathProximity), so communities lean toward directory trees
//                  without being bound to them: enough coupling across trees still wins
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

/**
 * @param runs  tie the files of a large directory in runs of neighbours (true) or all to the
 *              directory's hub (false). The hub version keeps a directory together and is what cities
 *              are formed on; the run version lets it divide and is what districts are formed on, so a
 *              big flat directory can become several districts but never drifts apart across cities.
 *              Nodes are numbered identically either way; only the affinity edges differ.
 */
export function buildClusterGraph(units: UnitTable, edges: UnitEdges, cfg: Config['clustering'], runs = true): ClusterGraph {
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

  // Directed edges as unordered node pairs, damped, then biased toward the directory tree.
  const bias = cfg.pathBias > 0 ? cfg.pathBias : 0;
  const depth = new Int32Array(bias > 0 ? n : 0);
  for (let i = 0; i < depth.length; i++) depth[i] = pathDepth(paths[i]);
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
    if (bias > 0) w *= 1 + bias * pathProximity(paths[s], paths[d], depth[s], depth[d]);
    lo[pairs] = s < d ? s : d; hi[pairs] = s < d ? d : s; dw[pairs] = w;
    pairs++;
  }

  // Directory affinity, then everything folded together: a pair of files can have code edges in
  // both directions and an affinity tie on top (two linked files of one run), and Louvain wants one
  // edge per pair.
  const affinity = cfg.directoryAffinity > 0
    ? directoryAffinity(n, paths, lo.subarray(0, pairs), hi.subarray(0, pairs), runs)
    : { a: [], b: [], hubs: [] };
  const nodes = n + affinity.hubs.length;
  const total = pairs + affinity.a.length;
  const allLo = new Int32Array(total), allHi = new Int32Array(total);
  const allW = new Float64Array(total);
  allLo.set(lo.subarray(0, pairs)); allHi.set(hi.subarray(0, pairs)); allW.set(dw.subarray(0, pairs));
  for (let k = 0; k < affinity.a.length; k++) {
    const x = affinity.a[k], y = affinity.b[k];
    allLo[pairs + k] = x < y ? x : y; allHi[pairs + k] = x < y ? y : x; allW[pairs + k] = cfg.directoryAffinity;
  }

  // Sorted by (lo, hi) so every edge of a pair meets, whatever order the edges came in.
  const order = countingSort(nodes, total, allLo, countingSort(nodes, total, allHi, null));
  let count = 0;
  for (let k = 0; k < total; k++) {
    const e = order[k];
    if (k === 0 || allLo[e] !== allLo[order[k - 1]] || allHi[e] !== allHi[order[k - 1]]) count++;
  }
  const a = new Int32Array(count);
  const b = new Int32Array(count);
  const w = new Float64Array(count);
  for (let j = 0, k = -1; j < total; j++) {
    const e = order[j];
    if (k < 0 || allLo[e] !== a[k] || allHi[e] !== b[k]) { k++; a[k] = allLo[e]; b[k] = allHi[e]; }
    w[k] += allW[e];
  }

  const size = new Float64Array(nodes);
  for (let i = 0; i < n; i++) size[i] = Math.max(1, units.fileCount[unitOf[i]] || 0);
  return { count, a, b, w, nodes, units: n, unitOf, paths, hubDirs: affinity.hubs, size };
}

/** A directory holding together more files than this ties them in runs instead of one star. */
const RUN_FROM = 16;

/**
 * Directory-affinity edges, linear in files. Hub node n + h stands for directory h.
 *   - A hub is tied to its parent directory's hub, and to the directory's files that have code
 *     edges; in a directory where no file has any, to all of its files. In a large directory those
 *     files are tied in runs of path-order neighbours instead of all to the hub, so it can divide
 *     (see the loop below and balance.ts).
 *   - A file with no code edges, in a directory that has files with some, is tied to the nearest
 *     such file before and after it in path order, and to nothing else: orphans follow the code
 *     beside them and never band together against it.
 */
function directoryAffinity(n: number, paths: readonly string[], ea: Int32Array, eb: Int32Array, runs: boolean): { a: number[]; b: number[]; hubs: string[] } {
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
    // The files a directory holds together are its files with code edges, or all of its files when
    // none has any. A small directory ties them straight to its hub. A large one (more than
    // RUN_FROM of them) would then be one star, a single indivisible community however many files
    // it held: tensorflow has data directories of 1,500 files, and react a fixtures directory with
    // hundreds of linked files. So a large directory ties them in runs of neighbours in path order
    // instead: each run is a small star around its first file, the first files are linked in order,
    // and the first of all hangs from the hub. Runs divide wherever the counts ask, and unlike one
    // long chain they cost Louvain nothing extra. A run is about √n files (the power of two nearest
    // it, so the length changes only when the directory grows or shrinks about fourfold), and where
    // a run starts is decided by a file's own name (a hash of its path, one start in `run` on
    // average), not by its position in the listing, so adding or removing a file moves at most the
    // boundaries next to it.
    const held = anchors === 0 ? k - from : anchors;
    const run = runs && held > RUN_FROM ? 2 ** Math.round(Math.log2(Math.sqrt(held))) : 0;
    const hold = (file: number) => {
      if (run === 0 || runHead < 0) { tie(file, n + h); runHead = file; }
      else if (hash32(paths[file]) % run === 0) { tie(file, runHead); runHead = file; }
      else tie(file, runHead);
    };
    for (let j = from, waiting = from; j < k; j++) {
      const file = byDir[j];
      if (anchors === 0) hold(file);
      else if (!connected[file]) { if (before >= 0) tie(file, before); } else {
        hold(file);
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

/** Directories above a file: 'a/b/c.ts' → 2; a root-level path → 0. */
export function pathDepth(path: string): number {
  let d = 0;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47) d++;
  return d;
}

/**
 * How close two files sit in the directory tree, 0..1: the share of the deeper file's directory
 * chain that the two have in common. Same directory 1; 'a/x/f' and 'a/y/g' 1/2; nothing shared 0.
 * Two files at the repo root share their (empty) directory, so 1.
 */
export function pathProximity(a: string, b: string, depthA = pathDepth(a), depthB = pathDepth(b)): number {
  const deepest = depthA > depthB ? depthA : depthB;
  if (deepest === 0) return 1;
  const n = a.length < b.length ? a.length : b.length;
  let shared = 0;
  for (let i = 0; i < n && a.charCodeAt(i) === b.charCodeAt(i); i++) if (a.charCodeAt(i) === 47) shared++;
  return shared / deepest;
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
