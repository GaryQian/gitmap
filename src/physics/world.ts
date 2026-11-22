// The engine's state: the replica, the nodes of all three tiers, their simulations, the district cells
// and the position buffers, plus what every part of the engine does with them: write rows into the
// buffers and keep a city's cells current. Radii and how they travel up the tiers are in space.ts.
import type { Config } from '../config';
import { GEN_ANY, GEN_CITY, GEN_DISTRICT0, GEN_HOT, type PhysicsInit, type PositionBuffers } from '../contracts/physics';
import type { ModelReplica } from '../contracts/store';
import { createReplica } from '../model';
import { allocateBuffers, capacityOf, fitCapacity, growBuffers } from './buffers';
import { cellsCurrent, computeCells, type LocalCell } from './cells';
import { createCityTier, type CityTier } from './cityTier';
import type { DistrictSim } from './districtTier';
import { fitInflate, type FileSim } from './fileTier';
import { isHot, type PNode } from './sim';
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
  /**
   * False until the first settle() or loadLayout(). Nothing ticks before then: the map is not shown
   * until it is settled (PLAN.md §6.8), and a layout that starts from the same state every time is
   * reproducible however the batches were spread over time.
   */
  revealed: boolean;
  /** Inside settle(): radii take their measured value at once instead of easing. */
  settling: boolean;
  /** Each district's Voronoi cell by district slot, local to the district centre (cells.ts). */
  cells: (LocalCell | undefined)[];
  /** Districts and cities whose radius is easing toward its goal. */
  easing: Set<PNode>;
  /** District simulations whose cells may be out of date: a centre or the city radius moved. */
  cellsDirty: Set<DistrictSim>;
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
    revealed: false,
    settling: false,
    cells: [],
    easing: new Set(),
    cellsDirty: new Set(),
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
    district[o] = n.x; district[o + 1] = n.y; district[o + 2] = n.bound;
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

/** Publish how many simulations are hot. Before the reveal nothing runs, so the count is 0. */
export function publishHot(w: World, extra = 0): number {
  const hot = w.revealed ? countHot(w) + w.easing.size + extra : 0;
  Atomics.store(w.positions.gen, GEN_HOT, hot);
  return hot;
}

// ---- cells ----

/**
 * Bring one city's cells up to date. They are recomputed only when a district centre or radius has
 * changed by more than `eps` since they were last computed (0 = any change at all).
 * Returns true when they were recomputed.
 */
export function refreshCells(w: World, ds: DistrictSim, eps: number): boolean {
  if (cellsCurrent(ds.cells, ds.nodes, eps)) return false;
  ds.cells = computeCells(ds.nodes, w.t.district.cellWeight, w.cells);
  for (const n of ds.nodes) {
    const fs = w.fileSims.get(n.slot);
    if (fs && fitInflate(fs, w.cells[n.slot], w.t)) fs.collide.refresh();
  }
  return true;
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
