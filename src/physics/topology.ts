// Patch batches → simulation topology (PLAN.md §5.1, §7.2).
//
// A batch is applied to the engine's own replica; the nodes and links of the three tiers are then
// brought in line with it. Only the simulations a batch touches are rebuilt, and each of those gets at
// most one nodes() and one links() call, followed by a gentle reheat.
//
// After the reveal a batch belongs to a user-triggered update (PLAN.md §6.8) and must stay local
// (IMPLEMENTATION.md §4): a file simulation whose units or links changed is reheated gently; a district
// or city simulation is woken only when its membership or a radius changed, and then with every node
// the batch did not touch pinned (space.ts). A change of link weights alone wakes nothing above the
// file tier: the weights are in place for the next time that tier runs.
//
// Which tier an edge belongs to depends on where its two units live:
//   same district               → a link in that district's file simulation
//   same city, other district   → weight on a district-pair link in that city's district simulation
//   different cities            → weight on a city-pair link, and on each district's pull toward the
//                                 other city (forceExternalPull)
// so moving a unit or a district re-homes its edges. The replica is read twice to find the affected
// simulations: before the batch is applied (where things were) and after (where they are now).
import type { PatchBatch } from '../model/types';
import { unitRadius } from '../shared';
import { clampIntoCell } from './cells';
import { createDistrictSim, estimateCityRadius, type DistrictSim } from './districtTier';
import { createFileSim, estimateDistrictRadius, fitInflate, rankTargets } from './fileTier';
import { placeCities, placeDistricts, placeUnits } from './placement';
import { applyTopology, enclosingRadius, heatFor, isHot, newNode, refreshRadii, reheat, setLinks, type PLink, type PNode } from './sim';
import { resizeDistrict, wakeTier } from './space';
import { ensureCapacity, externalBearing, refreshCells, type World } from './world';

/** What a batch touched. Slots are visited once however many operations name them. */
interface Dirty {
  /** A full batch: everything is visited and every simulation rebuilt. */
  all: boolean;
  cities: Set<number>;
  districts: Set<number>;
  units: Set<number>;
  /** City links need rebuilding. Also rebuilds every district's outside pulls. */
  cityLinks: boolean;
  /** City slots whose district links / outside pulls need rebuilding. */
  districtLinks: Set<number>;
  districtExternal: Set<number>;
  /** District slots whose file links need rebuilding. */
  fileLinks: Set<number>;
  /** City a moved unit was in before the batch (−1 for none). */
  cityBefore: Map<number, number>;
}

const PAIR = 67108864; // 2^26: slots stay far below this, so lo · PAIR + hi is an exact integer key

export function applyBatchToWorld(w: World, batch: PatchBatch): void {
  const full = !!batch.full;
  if (!full && batch.baseRev !== w.replica.rev) {
    throw new Error(`physics: revision gap (at ${w.replica.rev}, batch is based on ${batch.baseRev}); resync with a full batch`);
  }
  const dirty: Dirty = {
    all: full, cities: new Set(), districts: new Set(), units: new Set(), cityLinks: full,
    districtLinks: new Set(), districtExternal: new Set(), fileLinks: new Set(), cityBefore: new Map(),
  };
  if (!full) mark(w, batch, dirty, true);
  if (!w.replica.apply(batch)) throw new Error('physics: the replica refused the batch; resync with a full batch');
  ensureCapacity(w);
  if (!full) mark(w, batch, dirty, false);
  reconcile(w, dirty);
}

// ---- marking ----

function mark(w: World, batch: PatchBatch, dirty: Dirty, before: boolean): void {
  const units = w.replica.table('unit');
  for (const op of batch.ops) {
    if (op.op === 'assign') {
      const slots = op.units ?? op.unitIds.map((id) => units.slotOf(id));
      for (const s of slots) { dirty.units.add(s); markUnitMove(w, s, dirty, before); }
      continue;
    }
    if (op.op !== 'add' && op.op !== 'update' && op.op !== 'remove') continue;
    const slots = op.rows.slots;
    if (!slots) continue; // the replica rejects the batch
    const cols = op.rows.cols as Record<string, unknown>;
    switch (op.kind) {
      case 'edge':
        // a removed edge is only visible before the batch, an added one only after
        if (before ? op.op !== 'add' : op.op !== 'remove') for (const s of slots) markEdge(w, s, dirty);
        break;
      case 'unit': {
        const moves = op.op === 'remove' || (op.op === 'update' && 'district' in cols);
        if (op.op === 'update' && !moves && !('loc' in cols) && !('importancePct' in cols)) break;
        for (const s of slots) {
          dirty.units.add(s);
          if (moves && (before || op.op !== 'remove')) markUnitMove(w, s, dirty, before);
        }
        break;
      }
      case 'district': {
        const moves = op.op === 'remove' || (op.op === 'update' && 'city' in cols);
        if (op.op === 'update' && !moves) break;
        for (const s of slots) {
          dirty.districts.add(s);
          if (moves && (before || op.op !== 'remove')) markDistrictMove(w, s, dirty);
        }
        break;
      }
      case 'city':
        if (op.op !== 'update') for (const s of slots) dirty.cities.add(s);
        break;
    }
  }
}

function markEdge(w: World, slot: number, dirty: Dirty): void {
  const edges = w.replica.table('edge'), units = w.replica.table('unit'), districts = w.replica.table('district');
  const a = edges.refSlots.src[slot], b = edges.refSlots.dst[slot];
  if (!(a >= 0) || !(b >= 0)) return;
  const da = units.refSlots.district[a], db = units.refSlots.district[b];
  if (!(da >= 0) || !(db >= 0)) return;
  if (da === db) { dirty.fileLinks.add(da); return; }
  const ca = districts.refSlots.city[da], cb = districts.refSlots.city[db];
  if (!(ca >= 0) || !(cb >= 0)) return;
  if (ca === cb) dirty.districtLinks.add(ca);
  else { dirty.cityLinks = true; dirty.districtExternal.add(ca); dirty.districtExternal.add(cb); }
}

/** A unit joins or leaves a district: its edges may change tier, in ways only a rescan can tell. */
function markUnitMove(w: World, slot: number, dirty: Dirty, before: boolean): void {
  const d = w.replica.table('unit').refSlots.district[slot];
  const c = d >= 0 ? w.replica.table('district').refSlots.city[d] : -1;
  const city = c >= 0 ? c : -1;
  if (before) { if (!dirty.cityBefore.has(slot)) dirty.cityBefore.set(slot, city); }
  else if (dirty.cityBefore.get(slot) !== city) dirty.cityLinks = true;
  if (!(d >= 0)) return;
  dirty.fileLinks.add(d);
  if (city >= 0) { dirty.districtLinks.add(city); dirty.districtExternal.add(city); }
}

function markDistrictMove(w: World, slot: number, dirty: Dirty): void {
  const c = w.replica.table('district').refSlots.city[slot];
  if (c >= 0) { dirty.districtLinks.add(c); dirty.districtExternal.add(c); }
  dirty.cityLinks = true;
}

// ---- reconcile ----

function* visit(set: Set<number>, all: boolean, count: number): Iterable<number> {
  if (all) for (let s = 0; s < count; s++) yield s;
  else yield* set;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

const bySlot = (a: PNode, b: PNode) => a.slot - b.slot;
const ascending = (a: number, b: number) => a - b;

function sameLinks(a: readonly PLink[], b: readonly PLink[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].source !== b[i].source || a[i].target !== b[i].target || a[i].w !== b[i].w) return false;
  }
  return true;
}

function addWeight(map: Map<number, PLink>, a: PNode, b: PNode, weight: number): void {
  const lo = a.slot < b.slot ? a : b, hi = lo === a ? b : a;
  const key = lo.slot * PAIR + hi.slot;
  const link = map.get(key);
  if (link) link.w += weight; else map.set(key, { source: lo, target: hi, w: weight });
}

function reconcile(w: World, dirty: Dirty): void {
  const { t } = w;
  const units = w.replica.table('unit'), districts = w.replica.table('district'), cities = w.replica.table('city');
  const emptyRadius = t.file.pad; // a district with no units, a city with no districts
  w.lists = null;

  // 1. nodes: create, drop, re-parent and resize, to match the replica
  let cityNodesChanged = false, cityRadiiChanged = false;
  const cityAdds: PNode[] = [];
  const districtNodesDirty = new Set<number>(); // city slots
  const districtAdds = new Map<number, PNode[]>();
  const fileNodesDirty = new Set<number>(); // district slots
  const fileAdds = new Map<number, PNode[]>();

  for (const s of visit(dirty.cities, dirty.all, Math.max(w.cityNodes.length, cities.capacity))) {
    const id = cities.ids[s] ?? null;
    let n = w.cityNodes[s];
    if (n && n.id !== id) {
      w.cityNodes[s] = n = undefined;
      w.districtSims.delete(s);
      cityNodesChanged = true;
      dirty.cityLinks = true;
    }
    if (id !== null && !n) {
      w.cityNodes[s] = n = newNode(s, id, -1, emptyRadius);
      cityAdds.push(n);
      cityNodesChanged = true;
    }
  }

  for (const s of visit(dirty.districts, dirty.all, Math.max(w.districtNodes.length, districts.capacity))) {
    const id = districts.ids[s] ?? null;
    let n = w.districtNodes[s];
    if (n && n.id !== id) {
      if (n.parent >= 0) districtNodesDirty.add(n.parent);
      w.districtNodes[s] = n = undefined;
      w.fileSims.delete(s);
      w.external.delete(s);
      w.cells[s] = undefined;
    }
    if (id === null) continue;
    const c = districts.refSlots.city[s] >= 0 ? districts.refSlots.city[s] : -1;
    if (!n) {
      w.districtNodes[s] = n = newNode(s, id, c, emptyRadius);
    } else if (n.parent !== c) {
      if (n.parent >= 0) districtNodesDirty.add(n.parent);
      n.parent = c;
      n.placed = false;
      n.hasHome = false;
      n.fx = n.fy = null;
      w.pins.delete(n);
      w.cells[s] = undefined;
    } else continue;
    if (c >= 0) { push(districtAdds, c, n); districtNodesDirty.add(c); }
  }

  for (const s of visit(dirty.units, dirty.all, Math.max(w.unitNodes.length, units.capacity))) {
    const id = units.ids[s] ?? null;
    let n = w.unitNodes[s];
    if (n && n.id !== id) {
      if (n.parent >= 0) fileNodesDirty.add(n.parent);
      w.unitNodes[s] = n = undefined;
    }
    if (id === null) continue;
    const d = units.refSlots.district[s] >= 0 ? units.refSlots.district[s] : -1;
    const r = unitRadius(units.cols.loc[s], units.cols.importancePct[s], t.visual);
    if (!n) {
      w.unitNodes[s] = n = newNode(s, id, d, r);
      if (d >= 0) { push(fileAdds, d, n); fileNodesDirty.add(d); }
      else { w.positions.unit[2 * s] = 0; w.positions.unit[2 * s + 1] = 0; }
      continue;
    }
    if (n.parent !== d) {
      if (n.parent >= 0) fileNodesDirty.add(n.parent);
      n.parent = d;
      n.placed = false;
      n.hasHome = false;
      if (d >= 0) { push(fileAdds, d, n); fileNodesDirty.add(d); }
    }
    if (n.r !== r) {
      n.r = n.bound = r;
      if (d >= 0) fileNodesDirty.add(d);
    }
  }
  for (const n of w.pins) {
    if (w.cityNodes[n.slot] !== n && w.districtNodes[n.slot] !== n) w.pins.delete(n);
  }

  // 2. membership of every touched simulation, in slot order
  if (cityNodesChanged) w.cityTier.nodes = w.cityNodes.filter((n): n is PNode => !!n);

  for (const c of [...districtNodesDirty].sort(ascending)) {
    let ds = w.districtSims.get(c);
    const kept = ds ? ds.nodes.filter((n) => w.districtNodes[n.slot] === n && n.parent === c) : [];
    const nodes = w.cityNodes[c] ? kept.concat(districtAdds.get(c) ?? []).sort(bySlot) : [];
    if (ds && kept.length !== ds.nodes.length) dirty.districtLinks.add(c);
    if (!nodes.length) { w.districtSims.delete(c); continue; }
    if (!ds) {
      ds = createDistrictSim(c, t, {
        bearing: (n) => externalBearing(w, n),
        centroids: (sim) => { refreshCells(w, sim, t.district.cellEps); return sim.cells?.centroids ?? null; },
      });
      w.districtSims.set(c, ds);
    }
    for (const n of ds.held) if (!nodes.includes(n)) ds.held.delete(n);
    ds.nodes = nodes;
  }

  for (const d of [...fileNodesDirty].sort(ascending)) {
    let fs = w.fileSims.get(d);
    const kept = fs ? fs.nodes.filter((n) => w.unitNodes[n.slot] === n && n.parent === d) : [];
    const nodes = w.districtNodes[d] ? kept.concat(fileAdds.get(d) ?? []).sort(bySlot) : [];
    if (fs && kept.length !== fs.nodes.length) dirty.fileLinks.add(d);
    if (!nodes.length) { w.fileSims.delete(d); continue; }
    if (!fs) w.fileSims.set(d, (fs = createFileSim(d, t, () => w.cells[d])));
    fs.nodes = nodes;
  }
  w.lists = null;

  // 3. links: one pass over the edges fills every simulation whose links are stale
  const fileLinks = new Map<number, Map<number, PLink>>();
  const districtLinks = new Map<number, Map<number, PLink>>();
  const cityLinks = dirty.cityLinks ? new Map<number, PLink>() : null;
  const externalAll = dirty.all || dirty.cityLinks;
  for (const d of dirty.all ? w.fileSims.keys() : dirty.fileLinks) if (w.fileSims.has(d)) fileLinks.set(d, new Map());
  for (const c of dirty.all ? w.districtSims.keys() : dirty.districtLinks) if (w.districtSims.has(c)) districtLinks.set(c, new Map());
  if (externalAll) w.external.clear();
  else for (const d of [...w.external.keys()]) if (dirty.districtExternal.has(w.districtNodes[d]?.parent ?? -1)) w.external.delete(d);

  if (fileLinks.size || districtLinks.size || cityLinks || dirty.districtExternal.size) {
    const edges = w.replica.table('edge');
    const src = edges.refSlots.src, dst = edges.refSlots.dst, weight = edges.cols.weight, ids = edges.ids;
    const wantExternal = (c: number) => externalAll || dirty.districtExternal.has(c);
    const addExternal = (d: number, c: number, v: number) => {
      let m = w.external.get(d);
      if (!m) w.external.set(d, (m = new Map()));
      m.set(c, (m.get(c) ?? 0) + v);
    };
    // Classify from the replica's slot columns (small, dense arrays) and touch node objects only for
    // an edge some stale simulation wants: a small batch then scans a large model in a few milliseconds.
    const districtOf = units.refSlots.district, cityOf = districts.refSlots.city;
    const interCity = !!cityLinks || externalAll || dirty.districtExternal.size > 0;
    for (let e = 0; e < edges.capacity; e++) {
      if (ids[e] === null || ids[e] === undefined) continue;
      const ua = src[e], ub = dst[e];
      const da = districtOf[ua], db = districtOf[ub];
      if (!(da >= 0) || !(db >= 0) || ua === ub) continue;
      if (da === db) {
        const m = fileLinks.get(da);
        const a = m && w.unitNodes[ua], b = m && w.unitNodes[ub];
        if (m && a && b) addWeight(m, a, b, weight[e]);
        continue;
      }
      const ca = cityOf[da], cb = cityOf[db];
      if (!(ca >= 0) || !(cb >= 0)) continue;
      if (ca === cb) {
        const m = districtLinks.get(ca);
        const a = m && w.districtNodes[da], b = m && w.districtNodes[db];
        if (m && a && b) addWeight(m, a, b, weight[e]);
        continue;
      }
      if (!interCity) continue;
      const a = w.cityNodes[ca], b = w.cityNodes[cb];
      if (!a || !b || !w.districtNodes[da] || !w.districtNodes[db]) continue;
      if (cityLinks) addWeight(cityLinks, a, b, weight[e]);
      if (wantExternal(ca)) addExternal(da, cb, weight[e]);
      if (wantExternal(cb)) addExternal(db, ca, weight[e]);
    }
  }
  // Marking is conservative, so a rescanned simulation often has the links it had: leave those alone.
  for (const [d, m] of fileLinks) {
    const fs = w.fileSims.get(d)!, links = [...m.values()];
    if (sameLinks(fs.links, links)) fileLinks.delete(d); else setLinks(fs, links);
  }
  for (const [c, m] of districtLinks) {
    const ds = w.districtSims.get(c)!, links = [...m.values()];
    if (sameLinks(ds.links, links)) districtLinks.delete(c); else setLinks(ds, links);
  }
  let cityLinksChanged = false;
  if (cityLinks) {
    const links = [...cityLinks.values()];
    cityLinksChanged = !sameLinks(w.cityTier.links, links);
    if (cityLinksChanged) setLinks(w.cityTier, links);
  }

  // 4. sizes, bottom-up. A district's radius is the disc that holds its units packed; a city's is an area
  //    estimate until it has been measured from its settled districts.
  const districtRadiiDirty = new Set<number>(); // city slots
  const resized = new Map<number, PNode[]>(); // districts whose radius changed here, by city slot
  const resizedCities: PNode[] = [];
  const ranked = new Map<number, PNode[]>();
  for (const d of fileNodesDirty) {
    const dn = w.districtNodes[d];
    if (!dn) continue;
    const fs = w.fileSims.get(d);
    let r = emptyRadius;
    if (fs) {
      r = fs.estimate = fs.containR = estimateDistrictRadius(fs.nodes, t);
      ranked.set(d, rankTargets(fs, t));
      fitInflate(fs, w.cells[d], t); // sim.nodes() below re-reads the collide radii
    }
    if (r === dn.rGoal) continue;
    const before = dn.r;
    if (!resizeDistrict(w, dn, r)) continue; // eases in; each step of that wakes the city's districts
    if (dn.parent < 0) continue;
    districtRadiiDirty.add(dn.parent);
    // a change too small to ease is too small to wake anything for
    if (!w.revealed || Math.abs(r - before) > t.radiusEpsAbs) push(resized, dn.parent, dn);
  }
  for (const c of new Set([...districtNodesDirty, ...districtRadiiDirty])) {
    const cn = w.cityNodes[c];
    if (!cn) continue;
    const ds = w.districtSims.get(c);
    let r = cn.r;
    if (!ds) { r = emptyRadius; cn.measured = false; }
    else {
      ds.estimate = estimateCityRadius(ds.nodes, t);
      // room for what is there now as well as for what the estimate says is coming
      ds.containR = Math.max(ds.estimate, enclosingRadius(ds.nodes.filter((n) => n.placed)));
      ds.contentDirty = true;
      if (!cn.measured) r = ds.estimate;
    }
    if (r !== cn.r) {
      cn.r = cn.rGoal = cn.bound = r;
      w.easing.delete(cn);
      cityRadiiChanged = true;
      resizedCities.push(cn);
    }
  }

  // 5. positions for new nodes, top-down (a district's pull needs its city placed)
  const freshCities = !w.cityTier.nodes.some((n) => n.placed);
  placeCities(w.cityTier, cityAdds, w.seed, t);
  const freshDistricts = new Set<DistrictSim>();
  for (const [c, adds] of districtAdds) {
    const ds = w.districtSims.get(c);
    if (!ds) continue;
    if (!ds.nodes.some((n) => n.placed)) freshDistricts.add(ds);
    placeDistricts(ds, adds, w.seed, t);
  }
  for (const [d, adds] of fileAdds) {
    const fs = w.fileSims.get(d);
    if (!fs) continue;
    const cell = w.cells[d];
    placeUnits(fs, adds, ranked.get(d)!, w.seed, t, cell);
    if (cell) clampIntoCell(adds, cell); // a newcomer starts inside its district's territory
  }

  // 6. hand the changes to d3 and warm the simulations that changed. A first layout starts at alpha 1.
  //    After the reveal the warming is local: see the note at the top of this file.
  const live = w.revealed;
  for (const d of new Set([...fileNodesDirty, ...fileLinks.keys()])) {
    const fs = w.fileSims.get(d);
    if (!fs) continue;
    applyTopology(fs, fileNodesDirty.has(d), fileLinks.has(d));
    if (!live) reheat(fs.sim, t.reheat);
    else if (fs.nodes.some((n) => n.hasHome)) {
      // a district that was on show: its units shuffle gently and briefly
      const warm = isHot(fs.sim) && !fs.constraintsOnly ? Math.max(fs.sim.alpha(), t.reheat) : t.reheat;
      heatFor(fs.sim, warm, t.updateTicks);
      fs.constraintsOnly = false;
    } // else a district new to the map lays itself out from alpha 1, as before the reveal
    w.pending.files.add(fs);
  }
  for (const c of new Set([...districtNodesDirty, ...districtRadiiDirty, ...districtLinks.keys()])) {
    const ds = w.districtSims.get(c);
    if (!ds) continue;
    const nodesChanged = districtNodesDirty.has(c);
    applyTopology(ds, nodesChanged, districtLinks.has(c));
    if (!nodesChanged && districtRadiiDirty.has(c)) refreshRadii(ds);
    for (const n of ds.nodes) w.pending.districts.add(n);
    if (!live) reheat(ds.sim, freshDistricts.has(ds) ? 1 : t.reheat);
    else if (freshDistricts.has(ds)) reheat(ds.sim, 1); // a city new to the map: nothing to keep still
    else if (nodesChanged) wakeTier(w, ds, [...(districtAdds.get(c) ?? []), ...(resized.get(c) ?? [])], true);
    else if (resized.has(c)) wakeTier(w, ds, resized.get(c)!, false);
    if (live) w.cellsDirty.add(ds);
  }
  for (const [c, ds] of w.districtSims) {
    // outside pulls changed without a topology change: new bearings, no reheat
    if ((externalAll || dirty.districtExternal.has(c)) && !districtNodesDirty.has(c)) ds.external.refresh();
  }
  if (cityNodesChanged || cityLinksChanged || cityRadiiChanged) {
    applyTopology(w.cityTier, cityNodesChanged, cityLinksChanged);
    if (!cityNodesChanged && cityRadiiChanged) refreshRadii(w.cityTier);
    for (const n of w.cityTier.held) if (w.cityNodes[n.slot] !== n) w.cityTier.held.delete(n);
    w.pending.city = true;
    if (!w.cityTier.nodes.length) return;
    if (!live || freshCities) reheat(w.cityTier.sim, freshCities ? 1 : t.reheat);
    else if (cityNodesChanged) wakeTier(w, w.cityTier, [...cityAdds, ...resizedCities], true);
    else if (resizedCities.length) wakeTier(w, w.cityTier, resizedCities, false);
  }
}
