// Dividing giants where, and only where, they have structure (PLAN.md §6.6 "Balance"; see balance.ts).
//
// Louvain has a resolution limit: inside a large graph it cannot see communities below a certain
// size, so a region with clear internal structure can come back as one block of thousands of files.
// The remedy is not a size cap but a second look: a community larger than an even share of the wanted
// count is run through Louvain on its own subgraph, where that limit no longer hides anything. It is
// divided only if the division is real, meaning its modularity within the community reaches
// clustering.splitModularity. A block whose files all lean on each other with no pattern (modularity
// near zero) stays whole however large it is; a block made of sub-blocks comes apart along them.
import type { Config } from '../../config';
import type { EdgeList } from './graph';
import { louvainLevels } from './louvain';
import { communitySizes, labelCount } from './merge';

type ClusteringConfig = Config['clustering'];

/** How many times a piece may itself be examined. */
const MAX_DEPTH = 3;

/**
 * Modularity of a labelling of an undirected weighted graph: Σ_c [ inside_c / W − (degree_c / 2W)² ],
 * with W the total edge weight. 0 for a graph with no edges.
 */
export function modularity(labels: Int32Array, edges: EdgeList): number {
  const count = labelCount(labels);
  const inside = new Float64Array(count), degree = new Float64Array(count);
  let total = 0;
  for (let e = 0; e < edges.count; e++) {
    const w = edges.w[e], ca = labels[edges.a[e]], cb = labels[edges.b[e]];
    total += w;
    degree[ca] += w;
    degree[cb] += w;
    if (ca === cb) inside[ca] += w;
  }
  if (!(total > 0)) return 0;
  let q = 0;
  for (let c = 0; c < count; c++) q += inside[c] / total - (degree[c] / (2 * total)) ** 2;
  return q;
}

/**
 * `labels` with every giant that has real structure replaced by its parts. A giant is a community
 * larger than an even share, Σsize / `target`, scaled by `bias` (at 0 nothing is examined). Labels
 * come back numbered 0..count-1 in order of first appearance. Deterministic.
 *
 * @param nodeSize files per node (0 for a directory hub)
 */
export function refineGiants(
  labels: Int32Array,
  edges: EdgeList,
  nodeSize: ArrayLike<number>,
  target: number,
  cfg: ClusteringConfig,
  share?: number,
  depth = 0,
): Int32Array {
  const bias = Math.min(1, Math.max(0, cfg.sizeBias));
  const sizes = communitySizes(labels, nodeSize);
  if (bias === 0 || target <= 1 && share === undefined) return renumber(labels);
  let total = 0;
  for (let c = 0; c < sizes.length; c++) total += sizes[c];
  // An even share of the wanted count; a weaker bias tolerates proportionally larger communities.
  const even = share ?? total / Math.max(1, target) / bias;
  let any = false;
  for (let c = 0; c < sizes.length; c++) if (sizes[c] > even) { any = true; break; }
  if (!any) return renumber(labels);

  const count = sizes.length;
  const members: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < labels.length; i++) if (sizes[labels[i]] > even) members[labels[i]].push(i);
  const insideEdges: number[][] = Array.from({ length: count }, () => []);
  for (let e = 0; e < edges.count; e++) {
    const c = labels[edges.a[e]];
    if (c === labels[edges.b[e]] && sizes[c] > even) insideEdges[c].push(e);
  }

  const out = Int32Array.from(labels);
  const local = new Int32Array(labels.length);
  let next = count;
  for (let c = 0; c < count; c++) {
    if (sizes[c] <= even || insideEdges[c].length === 0) continue;
    const nodes = members[c];
    nodes.forEach((node, k) => { local[node] = k; });
    const es = insideEdges[c];
    const inside: EdgeList = { count: es.length, a: new Int32Array(es.length), b: new Int32Array(es.length), w: new Float64Array(es.length) };
    es.forEach((e, k) => { inside.a[k] = local[edges.a[e]]; inside.b[k] = local[edges.b[e]]; inside.w[k] = edges.w[e]; });

    const levels = louvainLevels(nodes.length, inside, cfg.resolution, cfg.seed);
    let parts = levels[levels.length - 1];
    if (labelCount(parts) < 2 || modularity(parts, inside) < cfg.splitModularity) continue; // one block: it stays whole
    if (depth + 1 < MAX_DEPTH) {
      const size = Float64Array.from(nodes, (node) => nodeSize[node]);
      parts = refineGiants(parts, inside, size, target, cfg, even, depth + 1);
    }
    // The first part keeps the community's label; the others get new ones.
    for (let k = 0; k < nodes.length; k++) out[nodes[k]] = parts[k] === 0 ? c : next + parts[k] - 1;
    next += labelCount(parts) - 1;
  }
  return renumber(out);
}

/**
 * The mirror image of refineGiants: communities that are not really separate are joined. Louvain
 * always returns some division, even of a block with no structure, and with the effective count
 * deciding when merging stops (balance.ts) such arbitrary pieces would otherwise be left standing.
 * Two communities are one block when the weight between them is at least `clustering.mergeCoupling`
 * times the geometric mean of the weights inside them: pieces of a random cut score about 2, real
 * neighbours far below 1. The geometric mean keeps a small community from being swallowed by a giant
 * just because most of its few edges point there. Repeats until no pair qualifies. Deterministic,
 * and independent of the order nodes and edges arrive in.
 */
export function mergeCohesive(labels: Int32Array, edges: EdgeList, cfg: ClusteringConfig): Int32Array {
  const threshold = cfg.mergeCoupling;
  const count = labelCount(labels);
  if (!(threshold > 0) || !(cfg.sizeBias > 0) || count < 2) return renumber(labels);
  const inside = new Float64Array(count);
  const adj: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  for (let e = 0; e < edges.count; e++) {
    const ca = labels[edges.a[e]], cb = labels[edges.b[e]], w = edges.w[e];
    if (ca === cb) { inside[ca] += w; continue; }
    adj[ca].set(cb, (adj[ca].get(cb) ?? 0) + w);
    adj[cb].set(ca, (adj[cb].get(ca) ?? 0) + w);
  }
  const parent = Int32Array.from({ length: count }, (_, c) => c);
  const find = (c: number): number => { while (parent[c] !== c) c = parent[c]; return c; };
  const alive = new Uint8Array(count).fill(1);

  // Qualifying pairs wait in a heap, most tightly coupled first and lowest indices first on a tie
  // (never Map order, so the result does not depend on the order edges arrive in). A community's
  // version goes up when it absorbs another; a queued pair with an old version is skipped.
  const version = new Int32Array(count);
  const heap: Pair[] = [];
  const queue = (x: number, y: number, w: number) => {
    const a = x < y ? x : y, b = x < y ? y : x;
    if (!(inside[a] > 0) || !(inside[b] > 0)) return;
    const k = w / Math.sqrt(inside[a] * inside[b]);
    if (k >= threshold) pushPair(heap, { k, a, b, va: version[a], vb: version[b] });
  };
  for (let c = 0; c < count; c++) for (const [d, w] of adj[c]) if (d > c) queue(c, d, w);

  for (let top = popPair(heap); top; top = popPair(heap)) {
    const { a, b } = top;
    if (!alive[a] || !alive[b] || version[a] !== top.va || version[b] !== top.vb) continue;
    // b joins a
    inside[a] += inside[b] + (adj[a].get(b) ?? 0);
    adj[a].delete(b);
    for (const [d, w] of adj[b]) {
      if (d === a) continue;
      adj[d].delete(b);
      adj[d].set(a, (adj[d].get(a) ?? 0) + w);
      adj[a].set(d, (adj[a].get(d) ?? 0) + w);
    }
    adj[b].clear();
    alive[b] = 0;
    parent[b] = a;
    version[a]++;
    for (const [d, w] of adj[a]) queue(a, d, w);
  }
  const out = new Int32Array(labels.length);
  for (let i = 0; i < labels.length; i++) out[i] = find(labels[i]);
  return renumber(out);
}

interface Pair { k: number; a: number; b: number; va: number; vb: number }

/** True when x comes out of the heap before y: tighter coupling, then lower a, then lower b. */
function pairFirst(x: Pair, y: Pair): boolean {
  return x.k > y.k || (x.k === y.k && (x.a < y.a || (x.a === y.a && x.b < y.b)));
}

function pushPair(h: Pair[], p: Pair): void {
  let i = h.length;
  h.push(p);
  while (i > 0) {
    const up = (i - 1) >> 1;
    if (!pairFirst(p, h[up])) break;
    h[i] = h[up];
    i = up;
  }
  h[i] = p;
}

function popPair(h: Pair[]): Pair | undefined {
  const top = h[0];
  const last = h.pop();
  if (h.length > 0 && last) {
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= h.length) break;
      if (child + 1 < h.length && pairFirst(h[child + 1], h[child])) child++;
      if (!pairFirst(h[child], last)) break;
      h[i] = h[child];
      i = child;
    }
    h[i] = last;
  }
  return top;
}

/** The same labelling numbered 0..count-1 in order of first appearance over the nodes. */
function renumber(labels: Int32Array): Int32Array {
  const map = new Map<number, number>();
  const out = new Int32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    let k = map.get(labels[i]);
    if (k === undefined) { k = map.size; map.set(labels[i], k); }
    out[i] = k;
  }
  return out;
}
