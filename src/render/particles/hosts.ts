// Which sphere each stellar-wind mote belongs to (PLAN.md §8.6): chosen in proportion to importance,
// so important files visibly shed more energy and the smallest shed almost none. Pure and seeded.
import { mulberry32 } from '../../shared';
import { PARTICLE_LOCAL } from './tunables';

/** How much wind a file sheds, from its importance percentile (0..1). */
export function windWeight(importancePct: number, t: typeof PARTICLE_LOCAL.wind = PARTICLE_LOCAL.wind): number {
  return importancePct > t.fromPct ? Math.pow(importancePct, t.power) : 0;
}

/**
 * A host slot for each of `count` motes, picked with probability proportional to `weight[slot]`
 * (0 or less: never a host). Returns −1 for every mote when nothing can host.
 */
export function chooseHosts(weight: ArrayLike<number>, count: number, seed: number): Int32Array {
  const hosts = new Int32Array(count).fill(-1);
  const cdf = new Float64Array(weight.length);
  let sum = 0;
  for (let i = 0; i < weight.length; i++) { const w = weight[i]; if (w > 0) sum += w; cdf[i] = sum; }
  if (!(sum > 0)) return hosts;
  const rnd = mulberry32(seed);
  for (let p = 0; p < count; p++) {
    const x = rnd() * sum;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] <= x) lo = m + 1; else hi = m; }
    hosts[p] = lo;
  }
  return hosts;
}
