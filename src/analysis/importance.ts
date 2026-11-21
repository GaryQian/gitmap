// Stage 4 — importance (PLAN.md §6.7): PageRank over the directed unit graph, then a percentile
// across the whole repo. Typed arrays and CSR adjacency throughout; no per-edge objects.

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
  /** Percentile of the rank across all units, 0..1. */
  pct: Float64Array;
  iterations: number;
}

/** Importance of `n` units. Rank flows from a unit to the units it depends on, by weight × confidence. */
export function computeImportance(n: number, edges: WeightedEdges, opts: PageRankOptions = {}): Importance {
  const w = new Float64Array(edges.count);
  for (let e = 0; e < edges.count; e++) w[e] = edges.weight[e] * edges.confidence[e];
  const { rank, iterations } = pageRank(n, edges.count, edges.src, edges.dst, w, opts);
  return { rank, pct: percentiles(rank), iterations };
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
 * Percentile by rank: the share of the other values that lie strictly below, 0..1. Ties share a
 * percentile, so a graph with no edges gives all zeros; a single value gets 1.
 */
export function percentiles(values: Float64Array): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (n === 1) { out[0] = 1; return out; }
  const sorted = Float64Array.from(values).sort();
  // First position of each tie group, per sorted position.
  const groupStart = new Int32Array(n);
  let start = 0;
  for (let i = 1; i < n; i++) {
    if (sorted[i] > sorted[start] * (1 + TIE_EPSILON)) start = i;
    groupStart[i] = start;
  }
  for (let u = 0; u < n; u++) {
    const v = values[u];
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    out[u] = groupStart[lo] / (n - 1);
  }
  return out;
}
