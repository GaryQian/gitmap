// Edge aggregation and budgeting (PLAN.md §8.3). Pure: no three.js, no replica.

/** Directed, weighted edges between slots. An edge with weight ≤ 0 is skipped. */
export interface EdgeList {
  count: number;
  src: ArrayLike<number>;
  dst: ArrayLike<number>;
  weight: ArrayLike<number>;
  /** Optional 0..1 per edge: how much of it is dimmed by the type filter. */
  dim?: ArrayLike<number>;
}

/** All traffic between two groups (districts or cities), `a < b`. */
export interface Ribbon {
  a: number;
  b: number;
  /** Total weight, both directions. */
  weight: number;
  /** Weight of the edges that run a → b; the rest runs b → a. */
  forward: number;
  /** Number of unit edges in it. */
  count: number;
  /** Weighted share of the ribbon that is dimmed, 0..1. */
  dim: number;
}

/** Share of a ribbon's traffic that runs a → b, 0..1. */
export function forwardShare(r: Ribbon): number {
  return r.weight > 0 ? r.forward / r.weight : 0.5;
}

/**
 * Sum edges into one ribbon per unordered pair of groups. `group[slot]` is the group of an endpoint
 * (−1 or undefined: none); edges inside one group, or with an endpoint in no group, are left out.
 */
export function aggregateRibbons(edges: EdgeList, group: ArrayLike<number>): Ribbon[] {
  let span = 0;
  for (let i = 0; i < group.length; i++) if (group[i] >= span) span = group[i] + 1;
  const sums = new RibbonSums(span);
  for (let e = 0; e < edges.count; e++) {
    sums.add(group[edges.src[e]] ?? -1, group[edges.dst[e]] ?? -1, edges.weight[e], edges.dim ? edges.dim[e] : 0);
  }
  return sums.finish();
}

/**
 * Ribbons summed one edge at a time, so a large edge list can be aggregated in slices across
 * animation frames (model.ts). `span` is one more than the largest group slot.
 */
export class RibbonSums {
  private byPair = new Map<number, Ribbon>();
  constructor(private span: number) {}

  /** One edge from group `ga` to group `gb`. Left out when either is negative, both are the same, or the weight is not positive. */
  add(ga: number, gb: number, weight: number, dim = 0): void {
    if (!(weight > 0) || ga < 0 || gb < 0 || ga === gb) return;
    const a = ga < gb ? ga : gb, b = ga < gb ? gb : ga;
    const key = a * this.span + b;
    let r = this.byPair.get(key);
    if (!r) this.byPair.set(key, (r = { a, b, weight: 0, forward: 0, count: 0, dim: 0 }));
    r.weight += weight;
    if (ga === a) r.forward += weight;
    r.count++;
    r.dim += weight * dim;
  }

  /** The ribbons, in first-seen order. Call once. */
  finish(): Ribbon[] {
    const out = [...this.byPair.values()];
    for (const r of out) r.dim = r.weight > 0 ? r.dim / r.weight : 0;
    return out;
  }
}

/**
 * How many instances each ambient level may draw at an edge scale (adaptive quality, PLAN.md §8.5).
 * Every level shrinks with the scale: city ribbons to a share of what there is (never below
 * `cityMin`), the others through their caps. Focus edges are not in here: they are never reduced.
 */
export function ambientCaps(
  scale: number, limits: { cityRibbons: number; cityMin: number; districtRibbons: number; ambientEdges: number },
): { city: number; district: number; file: number } {
  const s = Math.min(1, Math.max(0, scale));
  return {
    city: s >= 1 ? limits.cityRibbons : Math.min(limits.cityRibbons, Math.max(limits.cityMin, Math.ceil(limits.cityRibbons * s))),
    district: Math.max(1, Math.floor(limits.districtRibbons * s)),
    file: Math.max(0, Math.floor(limits.ambientEdges * s)),
  };
}

/**
 * Roll ribbons up one level (district ribbons → city ribbons). Every cross-city edge is also a
 * cross-district edge, so nothing is lost by starting from the district ribbons.
 */
export function rollUpRibbons(ribbons: readonly Ribbon[], parent: ArrayLike<number>): Ribbon[] {
  const n = ribbons.length;
  const src = new Int32Array(2 * n), dst = new Int32Array(2 * n);
  const weight = new Float64Array(2 * n), dim = new Float32Array(2 * n);
  const counts = new Map<number, number>();
  let span = 0;
  for (let i = 0; i < parent.length; i++) if (parent[i] >= span) span = parent[i] + 1;
  ribbons.forEach((r, i) => {
    src[2 * i] = r.a; dst[2 * i] = r.b; weight[2 * i] = r.forward; dim[2 * i] = r.dim;
    src[2 * i + 1] = r.b; dst[2 * i + 1] = r.a; weight[2 * i + 1] = r.weight - r.forward; dim[2 * i + 1] = r.dim;
    const pa = parent[r.a] ?? -1, pb = parent[r.b] ?? -1;
    if (pa >= 0 && pb >= 0 && pa !== pb) {
      const key = Math.min(pa, pb) * span + Math.max(pa, pb);
      counts.set(key, (counts.get(key) ?? 0) + r.count);
    }
  });
  const out = aggregateRibbons({ count: 2 * n, src, dst, weight, dim }, parent);
  for (const r of out) r.count = counts.get(r.a * span + r.b) ?? r.count;
  return out;
}

/** Indices of the `cap` strongest items, strongest first. Ties keep the lower index first. */
export function strongestFirst(strength: ArrayLike<number>, cap: number, candidates?: ArrayLike<number>): number[] {
  const idx: number[] = [];
  if (candidates) for (let i = 0; i < candidates.length; i++) idx.push(candidates[i]);
  else for (let i = 0; i < strength.length; i++) idx.push(i);
  idx.sort((x, y) => strength[y] - strength[x] || x - y);
  const n = Math.max(0, Math.floor(cap));
  if (idx.length > n) idx.length = n;
  return idx;
}

/**
 * Share a total budget between buffers listed in priority order: each takes what it wants from what
 * is left. The sum of the result never exceeds `budget`.
 */
export function allocateBudget(budget: number, wanted: readonly number[]): number[] {
  let left = Math.max(0, Math.floor(budget));
  return wanted.map((w) => {
    const take = Math.max(0, Math.min(left, Math.floor(w)));
    left -= take;
    return take;
  });
}

/** Map a raw weight to 0..1 against a typical weight: a saturating curve, so outliers do not flatten the rest. */
export function strength01(weight: number, typical: number): number {
  if (!(weight > 0) || !(typical > 0)) return 0;
  return 1 - Math.exp(-weight / typical);
}
