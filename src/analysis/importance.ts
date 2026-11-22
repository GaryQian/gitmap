// Stage 4 — importance (PLAN.md §6.7): PageRank over the directed unit graph, then a percentile
// among the units that have at least one dependent. Most units of a repo have none; ranked with the
// rest they would fill the bottom of the scale and push every unit with a dependent or two above
// the 90th percentile. Typed arrays and CSR adjacency throughout; no per-edge objects.

export interface PageRankOptions {
  damping?: number;
  maxIterations?: number;
  /** Stop when the total absolute change of one iteration falls below this (ranks sum to 1). */
  tolerance?: number;
}

// Fallbacks for direct callers; analyze() passes config.importance.
export const PAGERANK_DEFAULTS: Required<PageRankOptions> = { damping: 0.85, maxIterations: 100, tolerance: 1e-9 };

/** Ranks closer than this (relative) count as tied, so float noise never orders equivalent units. */
const TIE_EPSILON = 1e-9;

export interface WeightedEdges {
  count: number;
  /** The dependent (rank flows out of it). */
  src: Int32Array;
  /** The dependency (rank flows into it). */
  dst: Int32Array;
  weight: Float64Array;
  confidence: Float64Array;
}

export interface Importance {
  /** PageRank per unit; sums to 1. */
  rank: Float64Array;
  /** Percentile of the rank among the units that have a dependent, 1/k..1; 0 for a unit that has none. */
  pct: Float64Array;
  iterations: number;
}

/** Importance of `n` units. Rank flows from a unit to the units it depends on, by weight × confidence. */
export function computeImportance(n: number, edges: WeightedEdges, opts: PageRankOptions = {}): Importance {
  const w = new Float64Array(edges.count);
  for (let e = 0; e < edges.count; e++) w[e] = edges.weight[e] * edges.confidence[e];
  const { rank, iterations } = pageRank(n, edges.count, edges.src, edges.dst, w, opts);
  // A dependent is another unit with an edge that carries rank here (the edges pageRank uses).
  const hasDependent = new Uint8Array(n);
  for (let e = 0; e < edges.count; e++) if (w[e] > 0 && edges.src[e] !== edges.dst[e]) hasDependent[edges.dst[e]] = 1;
  return { rank, pct: percentiles(rank, hasDependent), iterations };
}

/**
 * Weighted PageRank. Edge e sends rank from src[e] to dst[e] in proportion to w[e]. Nodes with no
 * outgoing weight spread their rank uniformly. Self-edges and non-positive weights are ignored.
 */
export function pageRank(
  n: number, m: number, src: Int32Array, dst: Int32Array, w: Float64Array, opts: PageRankOptions = {},
): { rank: Float64Array; iterations: number } {
  const { damping, maxIterations, tolerance } = { ...PAGERANK_DEFAULTS, ...opts };
  if (n === 0) return { rank: new Float64Array(0), iterations: 0 };

  // CSR by source. Filling in edge order keeps each target's contributions in ascending source
  // order, which makes sums over a superset of dependents never smaller than over a subset.
  const offset = new Int32Array(n + 1);
  const outWeight = new Float64Array(n);
  for (let e = 0; e < m; e++) {
    if (!(w[e] > 0) || src[e] === dst[e]) continue;
    offset[src[e] + 1]++;
    outWeight[src[e]] += w[e];
  }
  for (let u = 0; u < n; u++) offset[u + 1] += offset[u];
  const used = offset[n];
  const target = new Int32Array(used);
  const share = new Float64Array(used);
  const cursor = offset.slice(0, n);
  for (let e = 0; e < m; e++) {
    if (!(w[e] > 0) || src[e] === dst[e]) continue;
    const at = cursor[src[e]]++;
    target[at] = dst[e];
    share[at] = w[e] / outWeight[src[e]];
  }

  let rank = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  let iterations = 0;
  if (used === 0) return { rank, iterations };
  while (iterations < maxIterations) {
    iterations++;
    let dangling = 0;
    for (let u = 0; u < n; u++) if (offset[u] === offset[u + 1]) dangling += rank[u];
    next.fill((1 - damping) / n + (damping * dangling) / n);
    for (let u = 0; u < n; u++) {
      const end = offset[u + 1];
      const r = damping * rank[u];
      for (let k = offset[u]; k < end; k++) next[target[k]] += r * share[k];
    }
    let delta = 0;
    for (let u = 0; u < n; u++) delta += Math.abs(next[u] - rank[u]);
    const swap = rank; rank = next; next = swap;
    if (delta < tolerance) break;
  }
  return { rank, iterations };
}

/**
 * Percentile among the ranked values only: the 1-based position of a value among the `k` ranked
 * ones, in ascending order, over `k`. So the lowest ranked value gets 1/k, a top value that stands
 * alone gets 1, and a single ranked value gets 1. Ties share the lowest position of their group
 * (three values tied at the top of ten all get 0.8), so a tie never lifts anything.
 * Values that are not ranked take no part and get 0; with nothing ranked, all are 0.
 */
export function percentiles(values: Float64Array, ranked: ArrayLike<number>): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  let k = 0;
  const pool = new Float64Array(n);
  for (let u = 0; u < n; u++) if (ranked[u]) pool[k++] = values[u];
  if (k === 0) return out;
  const sorted = pool.subarray(0, k).sort();
  // First position of each tie group, per sorted position.
  const groupStart = new Int32Array(k);
  let start = 0;
  for (let i = 1; i < k; i++) {
    if (sorted[i] > sorted[start] * (1 + TIE_EPSILON)) start = i;
    groupStart[i] = start;
  }
  for (let u = 0; u < n; u++) {
    if (!ranked[u]) continue;
    const v = values[u];
    let lo = 0, hi = k - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    out[u] = (groupStart[lo] + 1) / k;
  }
  return out;
}
