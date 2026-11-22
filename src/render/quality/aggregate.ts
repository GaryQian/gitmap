// District aggregates on very large maps (PLAN.md §8.1): when the camera is far, a district is drawn
// as one soft shape and its stars give way; they come back, one by one, as the camera approaches.
// This file is the rule, in JavaScript: the same maths as gmAggregate / gmAggregated in core/glsl.ts,
// so picking agrees with what the shaders draw. Pure.

/** Small and medium maps never aggregate. */
export function aggregatesEnabled(units: number, minUnits: number): boolean {
  return units >= minUnits;
}

/** A fixed 0..1 value per slot: the order in which a district's stars give way. Mirrors gmSlotHash. */
export function slotHash(slot: number): number {
  let h = Math.imul(slot, 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 8) / 16777216;
}

/** Radius on screen, in device pixels, of a star of `radius` at `distance`; `pixelWorld` is world units per device pixel at distance 1. */
export function starPixels(radius: number, pixelWorld: number, distance: number): number {
  return radius / (Math.max(pixelWorld, 1e-12) * Math.max(distance, 1e-3));
}

/**
 * How far a district has collapsed into its aggregate, from the on-screen size of a typical star
 * in it: 1 (aggregate only) below `range[0]` pixels, 0 (stars only) above `range[1]`, smooth between.
 */
export function aggregateAmount(starPx: number, range: readonly [number, number]): number {
  const [lo, hi] = range;
  if (!(hi > lo)) return starPx < lo ? 1 : 0;
  const t = Math.min(1, Math.max(0, (starPx - lo) / (hi - lo)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * True when the star in `slot` has given way to its district's aggregate. `keep` (0..1) holds a star
 * back: glow × the keepGlow tunable, so the most important stars are the last to go.
 */
export function isCollapsed(amount: number, slot: number, keep = 0): boolean {
  const a = amount * (1 - keep);
  return a > 0 && a >= slotHash(slot);
}

/** The middle radius of the live units: the "typical star" the thresholds are measured against. */
export function typicalRadius(info: ArrayLike<number>, capacity: number, stride = 4, samples = 2048): number {
  const n = Math.min(capacity, Math.floor(info.length / stride));
  const step = Math.max(1, Math.floor(n / samples));
  const radii: number[] = [];
  for (let u = 0; u < n; u += step) if (info[stride * u] > 0) radii.push(info[stride * u]);
  if (!radii.length) return 0;
  radii.sort((a, b) => a - b);
  return radii[radii.length >> 1];
}

export interface DistrictSums {
  /** Live units per district slot. */
  units: Int32Array;
  /** 0..1 per district slot: its summed importance against the heaviest district's (square root, so small districts stay visible). */
  brightness: Float32Array;
}

/**
 * Per district: how many units it holds and how bright its aggregate is. `info` holds
 * [radius, district slot, …] per unit slot (radius 0: empty); `importance` is 0..1 per unit slot.
 */
export function districtSums(districts: number, capacity: number, info: ArrayLike<number>, importance: ArrayLike<number>, stride = 4): DistrictSums {
  const units = new Int32Array(districts), sum = new Float64Array(districts), brightness = new Float32Array(districts);
  const n = Math.min(capacity, Math.floor(info.length / stride));
  for (let u = 0; u < n; u++) {
    const d = info[stride * u + 1];
    if (!(info[stride * u] > 0) || !(d >= 0) || d >= districts) continue;
    units[d]++;
    const w = importance[u];
    sum[d] += w > 0 ? w : 0;
  }
  let top = 0;
  for (let d = 0; d < districts; d++) if (sum[d] > top) top = sum[d];
  for (let d = 0; d < districts; d++) brightness[d] = units[d] ? (top > 0 ? Math.sqrt(sum[d] / top) : 1) : 0;
  return { units, brightness };
}
