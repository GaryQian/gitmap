import { describe, expect, it } from 'vitest';
import { mulberry32, now } from '../shared';
import { computeImportance, percentiles, type WeightedEdges } from './importance';

function graph(pairs: [number, number][], weight = 1, confidence = 1): WeightedEdges {
  return {
    count: pairs.length,
    src: Int32Array.from(pairs, (p) => p[0]),
    dst: Int32Array.from(pairs, (p) => p[1]),
    weight: new Float64Array(pairs.length).fill(weight),
    confidence: new Float64Array(pairs.length).fill(confidence),
  };
}

/** Distinct random pairs sorted by (src, dst), as the edge stage produces them. */
function randomPairs(n: number, m: number, seed: number): [number, number][] {
  const rnd = mulberry32(seed);
  const seen = new Set<number>();
  while (seen.size < m) {
    const s = Math.floor(rnd() * n), d = Math.floor(rnd() * rnd() * n);
    if (s !== d) seen.add(s * n + d);
  }
  return [...seen].sort((a, b) => a - b).map((k) => [Math.floor(k / n), k % n]);
}

describe('importance', () => {
  it('gives percentiles that are monotonic in PageRank, with ties sharing one', () => {
    const n = 500;
    const { rank, pct } = computeImportance(n, graph(randomPairs(n, 2000, 5)));
    expect(rank.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => rank[a] - rank[b]);
    for (let k = 1; k < n; k++) {
      const lo = order[k - 1], hi = order[k];
      expect(pct[hi]).toBeGreaterThanOrEqual(pct[lo]);
      if (rank[hi] === rank[lo]) expect(pct[hi]).toBe(pct[lo]);
    }
    expect(Math.min(...pct)).toBe(0);
    expect(Math.max(...pct)).toBeLessThanOrEqual(1);
    expect(pct[order[n - 1]]).toBeGreaterThan(0.99);
  });

  it('never ranks a unit below one whose dependents are a subset of its own', () => {
    // Hand-made: 0 is used by 3..7, 1 by 3 and 4 only, 2 by nobody.
    const small = computeImportance(8, graph([[3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [6, 0], [7, 0]]));
    expect(small.pct[0]).toBeGreaterThan(small.pct[1]);
    expect(small.pct[1]).toBeGreaterThan(small.pct[2]);
    expect(small.pct[2]).toBe(0);

    // Property over a random graph with uniform weights.
    const n = 120;
    const pairs = randomPairs(n, 500, 11);
    const dependents: Set<number>[] = Array.from({ length: n }, () => new Set());
    for (const [s, d] of pairs) dependents[d].add(s);
    const { rank, pct } = computeImportance(n, graph(pairs));
    let checked = 0;
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        if (a === b || dependents[b].size > dependents[a].size) continue;
        if (![...dependents[b]].every((x) => dependents[a].has(x))) continue;
        checked++;
        expect(rank[a]).toBeGreaterThanOrEqual(rank[b]);
        expect(pct[a]).toBeGreaterThanOrEqual(pct[b]);
      }
    }
    expect(checked).toBeGreaterThan(n);
  });

  it('counts indirect dependents and discounts low-confidence edges', () => {
    // 0 and 1 each have two direct dependents; those of 0 are themselves depended on by 6..9.
    const deep = computeImportance(10, graph([[2, 0], [3, 0], [4, 1], [5, 1], [6, 2], [7, 2], [8, 3], [9, 3]]));
    expect(deep.rank[0]).toBeGreaterThan(deep.rank[1]);
    // 2 splits its rank between a confident edge to 0 and a doubtful one to 1.
    const edges = graph([[2, 0], [2, 1]]);
    edges.confidence[1] = 0.25;
    const split = computeImportance(3, edges);
    expect(split.rank[0]).toBeGreaterThan(split.rank[1]);
  });

  it('handles the degenerate graphs', () => {
    expect(Array.from(computeImportance(0, graph([])).pct)).toEqual([]);
    expect(Array.from(computeImportance(1, graph([])).pct)).toEqual([1]);
    expect(Array.from(computeImportance(4, graph([])).pct)).toEqual([0, 0, 0, 0]);
    expect(Array.from(computeImportance(3, graph([[0, 1], [1, 2], [2, 0]])).pct)).toEqual([0, 0, 0]);
    expect(Array.from(percentiles(Float64Array.of(3, 1, 2, 1)))).toEqual([1, 0, 2 / 3, 0]);
  });

  it('reports its time on 100k units and 1M edges (log only)', () => {
    const n = 100_000, m = 1_000_000;
    const rnd = mulberry32(1);
    const edges: WeightedEdges = {
      count: m, src: new Int32Array(m), dst: new Int32Array(m),
      weight: new Float64Array(m).fill(1), confidence: new Float64Array(m).fill(1),
    };
    for (let e = 0; e < m; e++) {
      edges.src[e] = Math.floor(rnd() * n);
      edges.dst[e] = Math.floor(rnd() * rnd() * n); // skewed towards low indices, like real hubs
    }
    computeImportance(1000, graph(randomPairs(1000, 5000, 2))); // warm up
    const t0 = now();
    const { pct, iterations } = computeImportance(n, edges);
    console.log(`importance: ${n} units, ${m} edges, ${iterations} iterations, ${(now() - t0).toFixed(0)} ms`);
    expect(pct).toHaveLength(n);
  });
});
