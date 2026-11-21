// The engine's state: the replica, the nodes of all three tiers, their simulations and the position
// buffers, plus the two things every part of the engine does with them: write rows into the buffers,
// and carry a radius change up one tier ("space propagates upward", PLAN.md §7.1).
import type { Config } from '../config';
import { GEN_ANY, GEN_CITY, GEN_DISTRICT0, GEN_HOT, type PhysicsInit, type PositionBuffers } from '../contracts/physics';
import type { ModelReplica } from '../contracts/store';
import { createReplica } from '../model';
import { allocateBuffers, capacityOf, fitCapacity, growBuffers } from './buffers';
import { createCityTier, type CityTier } from './cityTier';
import { estimateCityRadius, type DistrictSim } from './districtTier';
import type { FileSim } from './fileTier';
import { enclosingRadius, isHot, refreshRadii, reheat, type PNode } from './sim';
import { tuningFrom, type Tuning } from './tuning';

export interface World {
  config: Config;
  t: Tuning;
  seed: number;
  replica: ModelReplica;
  positions: PositionBuffers;
  bufferListeners: Set<(b: PositionBuffers) => void>;
  /** Nodes by slot; undefined for an empty slot. */
  cityNodes: (PNode | undefined)[];
  districtNodes: (PNode | undefined)[];
  unitNodes: (PNode | undefined)[];
  cityTier: CityTier;
  /** District simulations by city slot; file simulations by district slot. Empty ones are not kept. */
  districtSims: Map<number, DistrictSim>;
  fileSims: Map<number, FileSim>;
  /** Per district slot: weight of its units' edges into each other city (for forceExternalPull). */
  external: Map<number, Map<number, number>>;
  /** Cities and districts held by a drag. */
  pins: Set<PNode>;
  /** Rows changed since the last flush. */
  pending: { city: boolean; districts: Set<PNode>; files: Set<FileSim> };
  /** Simulations in slot order, rebuilt lazily after the maps change. */
  lists: { districts: DistrictSim[]; files: FileSim[] } | null;
}

export function createWorld(init: PhysicsInit, buffers?: PositionBuffers): World {
  const t = tuningFrom(init.config);
  const cap = { units: Math.max(1, init.capacity.units), districts: Math.max(1, init.capacity.districts), cities: Math.max(1, init.capacity.cities) };
  return {
    config: init.config,
    t,
    seed: (init.seed ?? init.config.clustering.seed) >>> 0,
    replica: createReplica(),
    positions: buffers ?? allocateBuffers(cap),
    bufferListeners: new Set(),
    cityNodes: [],
    districtNodes: [],
    unitNodes: [],
    cityTier: createCityTier(t),
    districtSims: new Map(),
    fileSims: new Map(),
    external: new Map(),
    pins: new Set(),
    pending: { city: false, districts: new Set(), files: new Set() },
    lists: null,
  };
}

export function simLists(w: World): { districts: DistrictSim[]; files: FileSim[] } {
  if (!w.lists) {
    w.lists = {
      districts: [...w.districtSims.values()].sort((a, b) => a.city - b.city),
      files: [...w.fileSims.values()].sort((a, b) => a.district - b.district),
    };
  }
  return w.lists;
}

/** Grow the buffers when the model's slots outgrow them, and tell whoever reads them. */
export function ensureCapacity(w: World): void {
  const need = {
    units: w.replica.table('unit').capacity,
    districts: w.replica.table('district').capacity,
    cities: w.replica.table('city').capacity,
  };
  const next = fitCapacity(capacityOf(w.positions), need);
  if (!next) return;
  w.positions = growBuffers(w.positions, next);
  for (const fn of [...w.bufferListeners]) fn(w.positions);
}

// ---- rows ----

/** Write every pending row and bump the generation counters the renderer watches. */
export function flush(w: World): void {
  const { unit, district, city, gen } = w.positions;
  const p = w.pending;
  let any = false;
  if (p.city) {
    for (const n of w.cityTier.nodes) {
      const o = 3 * n.slot;
      city[o] = n.x; city[o + 1] = n.y; city[o + 2] = n.r;
    }
    Atomics.add(gen, GEN_CITY, 1);
    p.city = false;
    any = true;
  }
  for (const n of p.districts) {
    if (w.districtNodes[n.slot] !== n) continue;
    const o = 3 * n.slot;
    district[o] = n.x; district[o + 1] = n.y; district[o + 2] = n.r;
    Atomics.add(gen, GEN_DISTRICT0 + n.slot, 1);
    any = true;
  }
  p.districts.clear();
  for (const fs of p.files) {
    if (w.fileSims.get(fs.district) !== fs) continue;
    for (const n of fs.nodes) {
      const o = 2 * n.slot;
      unit[o] = n.x; unit[o + 1] = n.y;
    }
    Atomics.add(gen, GEN_DISTRICT0 + fs.district, 1);
    any = true;
  }
  p.files.clear();
  if (any) Atomics.add(gen, GEN_ANY, 1);
}

/** Queue every row of every tier (after a settle or a loaded layout). */
export function touchAll(w: World): void {
  const { districts, files } = simLists(w);
  w.pending.city = true;
  for (const ds of districts) for (const n of ds.nodes) w.pending.districts.add(n);
  for (const fs of files) w.pending.files.add(fs);
}

export function countHot(w: World): number {
  const { districts, files } = simLists(w);
  let hot = isHot(w.cityTier.sim) ? 1 : 0;
  for (const ds of districts) if (isHot(ds.sim)) hot++;
  for (const fs of files) if (isHot(fs.sim)) hot++;
  return hot;
}

export function publishHot(w: World, extra = 0): number {
  const hot = countHot(w) + extra;
  Atomics.store(w.positions.gen, GEN_HOT, hot);
  return hot;
}

// ---- radii: measured from content, carried upward ----

function significant(w: World, before: number, after: number): boolean {
  return Math.abs(after - before) > Math.max(w.t.radiusEpsAbs, w.t.radiusEpsRel * before);
}

/** A district's radius changed: its city's simulation re-reads radii and sizes its containment for the new content. */
export function districtRadiusChanged(w: World, ds: DistrictSim): void {
  refreshRadii(ds);
  ds.estimate = estimateCityRadius(ds.nodes, w.t);
  ds.containR = ds.estimate;
  ds.contentDirty = true;
}

/**
 * Set a district's radius from where its units are now: the enclosing radius of its spheres, plus pad.
 * `exact` (the file simulation is at rest) records any difference and tightens containment to the
 * measured size; otherwise only a significant change is taken, and that reheats the city's districts
 * so siblings make room.
 */
export function measureDistrict(w: World, d: number, exact: boolean): void {
  const dn = w.districtNodes[d];
  if (!dn) return;
  const fs = w.fileSims.get(d);
  const enclosing = fs ? enclosingRadius(fs.nodes) : 0;
  if (exact && fs) fs.containR = enclosing;
  const r = enclosing + w.t.file.pad;
  const big = significant(w, dn.r, r);
  if (exact) dn.measured = true;
  if (!big && !(exact && r !== dn.r)) return;
  dn.r = r;
  dn.measured = true;
  w.pending.districts.add(dn);
  const ds = w.districtSims.get(dn.parent);
  if (!ds) return;
  districtRadiusChanged(w, ds);
  if (big) reheat(ds.sim, w.t.reheat);
}

/** As measureDistrict, one tier up: a city's radius from where its districts are now. */
export function measureCity(w: World, c: number, exact: boolean): void {
  const cn = w.cityNodes[c];
  if (!cn) return;
  const ds = w.districtSims.get(c);
  const enclosing = ds ? enclosingRadius(ds.nodes) : 0;
  if (exact && ds) ds.containR = enclosing;
  const r = enclosing + w.t.district.pad;
  const big = significant(w, cn.r, r);
  if (exact) cn.measured = true;
  if (!big && !(exact && r !== cn.r)) return;
  cn.r = r;
  cn.measured = true;
  w.pending.city = true;
  refreshRadii(w.cityTier);
  if (big) reheat(w.cityTier.sim, w.t.reheat);
}

/** Unit vector from a district's city toward the weighted mean bearing of the cities it links to. */
export function externalBearing(w: World, n: PNode): readonly [number, number] {
  const weights = w.external.get(n.slot);
  const me = w.cityNodes[n.parent];
  if (!weights || !me) return ZERO;
  let x = 0, y = 0;
  for (const [c, weight] of weights) {
    const o = w.cityNodes[c];
    if (!o) continue;
    const dx = o.x - me.x, dy = o.y - me.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    x += (dx / len) * weight;
    y += (dy / len) * weight;
  }
  const len = Math.sqrt(x * x + y * y);
  return len > 0 ? [x / len, y / len] : ZERO;
}
const ZERO: readonly [number, number] = [0, 0];
