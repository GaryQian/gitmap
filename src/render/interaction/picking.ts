// Picking on the CPU, hierarchical (PLAN.md §9): ray → cities → districts → the spheres of each
// district the ray can reach. Positions are the rest positions physics wrote (never the jiggle
// offset), composed exactly as the shaders compose them. Pure: no DOM, no WebGL.
//
// Cities and districts are tested as circles measured from their contents (the footprint of every
// sphere inside), not as the Voronoi cells. Containment in a cell is soft, and in a tilted view a
// sphere's upper half is seen over the neighbouring cell, so a lookup by the cell under the ground
// point would miss spheres near a border. A measured circle cannot.
import type * as THREE from 'three';
import { GEN_ANY, GEN_CITY, GEN_DISTRICT0, type PositionBuffers } from '../../contracts/physics';

/** Origin and unit direction. */
export interface Ray { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }

/**
 * Distance along the ray to a sphere's surface: 0 when the origin is inside it, −1 when the ray
 * misses or the sphere is behind the origin.
 */
export function raySphere(ray: Ray, cx: number, cy: number, cz: number, r: number): number {
  const lx = cx - ray.ox, ly = cy - ray.oy, lz = cz - ray.oz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  if (c <= 0) return 0;
  const b = lx * ray.dx + ly * ray.dy + lz * ray.dz;
  if (!(b > 0)) return -1;
  const disc = b * b - c;
  return disc >= 0 ? b - Math.sqrt(disc) : -1;
}

/** Where the ray meets the ground plane (y = 0), or null when it runs level or upward. */
export function rayGround(ray: Ray): { x: number; z: number; t: number } | null {
  if (ray.dy > -1e-9) return null;
  const t = -ray.oy / ray.dy;
  return t >= 0 ? { x: ray.ox + ray.dx * t, z: ray.oz + ray.dz * t, t } : null;
}

export function pointInCircle(x: number, z: number, cx: number, cz: number, r: number): boolean {
  const dx = x - cx, dz = z - cz;
  return dx * dx + dz * dz <= r * r;
}

/** Squared distance from the point (px, pz) to the segment a → b, on the ground plane. */
export function segmentDistance2(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const ex = bx - ax, ez = bz - az;
  const len2 = ex * ex + ez * ez;
  let t = len2 > 0 ? ((px - ax) * ex + (pz - az) * ez) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + ex * t - px, dz = az + ez * t - pz;
  return dx * dx + dz * dz;
}

/** The ray through a canvas pixel (CSS pixels, canvas-relative) of a camera whose matrices are current. */
export function rayThroughPixel(camera: THREE.Camera, width: number, height: number, x: number, y: number, scratch: THREE.Vector3): Ray {
  const o = camera.position;
  const p = scratch.set((x / width) * 2 - 1, 1 - (y / height) * 2, 0.5).unproject(camera);
  const dx = p.x - o.x, dy = p.y - o.y, dz = p.z - o.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  return { ox: o.x, oy: o.y, oz: o.z, dx: dx / len, dy: dy / len, dz: dz / len };
}

/**
 * Which units sit in which district, and which districts in which city, as flat lists; plus the
 * measured bounding circle of each district and city. Built from the per-unit lookup rows
 * (`[radius, district slot, city slot, …]`, radius 0 for an empty slot), so it follows the model
 * exactly as the spheres are drawn.
 */
export interface PickIndex {
  /** Radius per unit slot (0 = no sphere). */
  radius: Float32Array;
  /** Largest radius of any unit. */
  maxRadius: number;
  /** City slots that hold at least one sphere. */
  cities: number[];
  /** Districts of city c: districtList[cityStart[c] .. cityStart[c + 1]). */
  cityStart: Int32Array;
  districtList: Int32Array;
  /** Units of district d: unitList[districtStart[d] .. districtStart[d + 1]). */
  districtStart: Int32Array;
  unitList: Int32Array;
  /** City slot of each district slot (−1 when it holds no sphere). */
  districtCity: Int32Array;
  /** Radius around a district's centre that contains every one of its spheres' footprints. */
  districtBound: Float32Array;
  /** The same around a city's centre. */
  cityBound: Float32Array;
  /** Generation counters the bounds were measured at. */
  seen: { buffers: PositionBuffers | null; any: number; city: number; districts: Int32Array };
}

/** Build the index from lookup rows of `stride` floats per unit slot: [radius, district slot, city slot, …]. */
export function buildPickIndex(info: ArrayLike<number>, capacity: number, stride = 4): PickIndex {
  const n = Math.min(capacity, Math.floor(info.length / stride));
  const radius = new Float32Array(n);
  let districts = 0, cities = 0, maxRadius = 0;
  for (let u = 0; u < n; u++) {
    const r = info[stride * u], d = info[stride * u + 1], c = info[stride * u + 2];
    if (!(r > 0) || !(d >= 0) || !(c >= 0)) continue;
    radius[u] = r;
    if (r > maxRadius) maxRadius = r;
    if (d >= districts) districts = d + 1;
    if (c >= cities) cities = c + 1;
  }
  const districtCity = new Int32Array(districts).fill(-1);
  const districtStart = new Int32Array(districts + 1);
  for (let u = 0; u < n; u++) {
    if (!radius[u]) continue;
    const d = info[stride * u + 1];
    districtStart[d + 1]++;
    districtCity[d] = info[stride * u + 2];
  }
  for (let d = 0; d < districts; d++) districtStart[d + 1] += districtStart[d];
  const unitList = new Int32Array(districtStart[districts]);
  const fill = districtStart.slice(0, districts);
  for (let u = 0; u < n; u++) if (radius[u]) unitList[fill[info[stride * u + 1]]++] = u;

  const cityStart = new Int32Array(cities + 1);
  for (let d = 0; d < districts; d++) if (districtCity[d] >= 0) cityStart[districtCity[d] + 1]++;
  for (let c = 0; c < cities; c++) cityStart[c + 1] += cityStart[c];
  const districtList = new Int32Array(cityStart[cities]);
  const fillCity = cityStart.slice(0, cities);
  for (let d = 0; d < districts; d++) if (districtCity[d] >= 0) districtList[fillCity[districtCity[d]]++] = d;
  const cityList: number[] = [];
  for (let c = 0; c < cities; c++) if (cityStart[c + 1] > cityStart[c]) cityList.push(c);

  return {
    radius, maxRadius, cities: cityList, cityStart, districtList, districtStart, unitList, districtCity,
    districtBound: new Float32Array(districts), cityBound: new Float32Array(cities),
    seen: { buffers: null, any: -1, city: -1, districts: new Int32Array(districts).fill(-1) },
  };
}

/**
 * Bring the measured bounds up to date with the position buffers. Costs nothing when no counter
 * moved; otherwise only the districts whose counter moved are measured again.
 */
export function refreshBounds(index: PickIndex, pos: PositionBuffers): void {
  const { seen } = index;
  const gen = pos.gen;
  const any = gen.length > GEN_ANY ? Atomics.load(gen, GEN_ANY) : 0;
  const fresh = seen.buffers !== pos;
  if (!fresh && any === seen.any) return;
  const city = gen.length > GEN_CITY ? Atomics.load(gen, GEN_CITY) : 0;
  const districts = index.districtBound.length;
  // a write that bumped no finer counter may have moved anything (the same rule as the core's textures)
  let finer = city !== seen.city;
  const changed: number[] = [];
  for (let d = 0; d < districts; d++) {
    const g = GEN_DISTRICT0 + d < gen.length ? Atomics.load(gen, GEN_DISTRICT0 + d) : any;
    if (g !== seen.districts[d]) { seen.districts[d] = g; changed.push(d); finer = true; }
  }
  seen.buffers = pos; seen.any = any; seen.city = city;
  const all = fresh || !finer;
  const dirtyCities = new Set<number>();
  const measure = (d: number) => {
    let bound = 0;
    for (let i = index.districtStart[d]; i < index.districtStart[d + 1]; i++) {
      const u = index.unitList[i];
      if (2 * u + 1 >= pos.unit.length) continue;
      const x = pos.unit[2 * u], z = pos.unit[2 * u + 1];
      const reach = Math.sqrt(x * x + z * z) + index.radius[u];
      if (reach > bound) bound = reach;
    }
    index.districtBound[d] = bound;
    if (index.districtCity[d] >= 0) dirtyCities.add(index.districtCity[d]);
  };
  if (all) for (let d = 0; d < districts; d++) measure(d);
  else for (const d of changed) measure(d);
  for (const c of dirtyCities) {
    let bound = 0;
    for (let i = index.cityStart[c]; i < index.cityStart[c + 1]; i++) {
      const d = index.districtList[i];
      if (3 * d + 2 >= pos.district.length) continue;
      const reach = Math.hypot(pos.district[3 * d], pos.district[3 * d + 1]) + index.districtBound[d];
      if (reach > bound) bound = reach;
    }
    index.cityBound[c] = bound;
  }
}

export interface PickOptions {
  /** False for a sphere that is not drawn (hidden by the size slider, not yet revealed): it is skipped. */
  isShown?: (slot: number) => boolean;
  /**
   * Smallest target radius per unit of distance from the ray's origin: a pixel tolerance in world
   * units (`pixels × worldPerPixel(1)`). 0 picks the spheres exactly.
   */
  minRadiusPerDistance?: number;
  /** Nothing further than this along the ray is considered. */
  maxDistance?: number;
}

export interface PickHit { slot: number; /** Distance along the ray. */ t: number }

/**
 * The nearest shown sphere along the ray, or null. A sphere's centre sits at y = radius over its
 * rest position; `refreshBounds` is applied first, so the buffers may have moved since the last call.
 */
export function pickUnit(ray: Ray, index: PickIndex, pos: PositionBuffers, opts: PickOptions = {}): PickHit | null {
  if (!index.cities.length) return null;
  refreshBounds(index, pos);
  const tol = Math.max(0, opts.minRadiusPerDistance ?? 0);
  const far = opts.maxDistance ?? 1e6;
  const { ox, oy, oz, dx, dy, dz } = ray;
  // Every sphere the ray can touch has its surface point between y = −reach and y = 2·reach, where
  // `reach` is the largest target radius in play. That stretch of the ray, seen from above, is a
  // segment; a sphere can be hit only if its centre is within `reach` of it.
  const down = dy < -1e-9;
  let reach = index.maxRadius;
  if (tol > 0) reach = Math.max(reach, tol * (down ? Math.min(far, (oy + reach) / -dy) : far));
  let tA = 0, tB = far;
  if (down) {
    if (oy > 2 * reach) tA = (oy - 2 * reach) / -dy;
    tB = Math.min(far, (oy + reach) / -dy);
  } else {
    if (oy > 2 * reach) return null;
    if (dy > 1e-9) tB = Math.min(far, (2 * reach - oy) / dy);
  }
  if (tA > tB) return null;
  const ax = ox + dx * tA, az = oz + dz * tA, bx = ox + dx * tB, bz = oz + dz * tB;

  const { isShown } = opts;
  let best = Infinity, slot = -1;
  for (const c of index.cities) {
    if (3 * c + 2 >= pos.city.length) continue;
    const cx = pos.city[3 * c], cz = pos.city[3 * c + 1];
    const cityReach = index.cityBound[c] + reach;
    if (!(segmentDistance2(ax, az, bx, bz, cx, cz) <= cityReach * cityReach)) continue;
    for (let i = index.cityStart[c]; i < index.cityStart[c + 1]; i++) {
      const d = index.districtList[i];
      if (3 * d + 2 >= pos.district.length) continue;
      const gx = cx + pos.district[3 * d], gz = cz + pos.district[3 * d + 1];
      const districtReach = index.districtBound[d] + reach;
      if (!(segmentDistance2(ax, az, bx, bz, gx, gz) <= districtReach * districtReach)) continue;
      for (let j = index.districtStart[d]; j < index.districtStart[d + 1]; j++) {
        const u = index.unitList[j];
        if (2 * u + 1 >= pos.unit.length) continue;
        const r = index.radius[u];
        const ux = gx + pos.unit[2 * u], uz = gz + pos.unit[2 * u + 1];
        let target = r;
        if (tol > 0) {
          const ex = ux - ox, ey = r - oy, ez = uz - oz;
          target = Math.min(reach, Math.max(r, tol * Math.sqrt(ex * ex + ey * ey + ez * ez)));
        }
        const t = raySphere(ray, ux, r, uz, target);
        if (!(t >= 0 && t < best && t <= far)) continue;
        if (isShown && !isShown(u)) continue;
        best = t; slot = u;
      }
    }
  }
  return slot < 0 ? null : { slot, t: best };
}

/** Call `fn` for every indexed unit with its rest centre in world coordinates (y = radius). */
export function forEachUnit(index: PickIndex, pos: PositionBuffers, fn: (slot: number, x: number, y: number, z: number) => void): void {
  for (const c of index.cities) {
    if (3 * c + 2 >= pos.city.length) continue;
    const cx = pos.city[3 * c], cz = pos.city[3 * c + 1];
    for (let i = index.cityStart[c]; i < index.cityStart[c + 1]; i++) {
      const d = index.districtList[i];
      if (3 * d + 2 >= pos.district.length) continue;
      const gx = cx + pos.district[3 * d], gz = cz + pos.district[3 * d + 1];
      for (let j = index.districtStart[d]; j < index.districtStart[d + 1]; j++) {
        const u = index.unitList[j];
        if (2 * u + 1 >= pos.unit.length) continue;
        fn(u, gx + pos.unit[2 * u], index.radius[u], gz + pos.unit[2 * u + 1]);
      }
    }
  }
}
