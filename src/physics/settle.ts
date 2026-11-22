// The pre-reveal settle (PLAN.md §6.8, §7.2): run every hot simulation to rest with no rendering,
// under a time cap, then mark home.
//
// Order. A district's radius comes from its content packed (fileTier.ts), not from where its units
// happen to be, so the tiers are laid out from the top and the units are settled last, straight into
// the territory they will be shown in:
//   1. city simulation, first pass → gives districts a bearing toward the cities they depend on;
//                                     city radii are still area estimates here
//   2. district simulations        → districts packed against each other; each city's radius = the
//                                     circle enclosing its districts, plus pad
//   3. city simulation, again      → cities against their measured radii, never closer than the gap
//   4. territories                 → every city's cells (cells.ts)
//   5. file simulations            → each district's units spread over its cell
//
// Every tier ends on its constraints alone. Cooling is a schedule, not an equilibrium: the link force
// fades with alpha and leaves hub neighbourhoods packed tighter than their spheres allow, which is the
// overlap the spike measured. So after a tier has cooled it runs on with only collide and containment
// until nothing moves; that undoes the overlap and nothing else. The city and district tiers are first
// squeezed (their pull toward the middle against collide, nothing pushing apart), so districts touch
// and cities sit no further apart than they must, and last of all any pair still closer than its
// spacing is moved apart directly: the gap between two cities is a hard minimum.
//
// The cap. The file tier is nearly all of the time, so the cap applies to it: a share for the full
// forces, the rest for relaxation. The city and district tiers are a few dozen small simulations
// costing milliseconds and always run to rest. Units start on a spiral over their cell that is already
// evenly spread, so however short the cap falls, cities and districts do not overlap and every unit is
// inside its district's cell; what the cap cost is overlap between units, reported with atRest: false.
//
// Nothing here depends on the clock except the cap, and simulations of a tier are independent, so the
// same batches and seed give the same layout whenever the cap is not reached.
import type { SettleReport } from '../contracts/physics';
import { now } from '../shared';
import { clampIntoCell, hasStray } from './cells';
import { citySpacing } from './cityTier';
import { districtSpacing, enclosingCentre } from './districtTier';
import { rankTargets } from './fileTier';
import { separate } from './forces';
import { spiralUnits } from './placement';
import { overlapShare } from './quality';
import { isHot, maxSpeed2, refreshRadii, sleep, type Sim, type SimParts } from './sim';
import { endAllUpdates, measureCity, snapRadii } from './space';
import { flush, refreshCells, simLists, touchAll, type World } from './world';

/** Ticks given to one simulation before moving to the next, so a cap cuts every simulation equally short. */
const ROUND = 10;

interface Run { ticks: number; done: boolean }

/** Tick hot simulations until all are at rest or the clock passes `until`. */
function runToRest(sims: Sim[], until: number): Run {
  let ticks = 0;
  let hot = sims.filter(isHot);
  while (hot.length) {
    for (const sim of hot) {
      if (now() >= until) return { ticks, done: false };
      for (let k = 0; k < ROUND && isHot(sim); k++) { sim.tick(); ticks++; }
    }
    hot = hot.filter(isHot);
  }
  return { ticks, done: true };
}

/**
 * Run simulations on their constraints alone until nothing in them moves faster than relaxSpeed, for at
 * most relaxTicks ticks each, or until the clock passes `until`. A simulation in which no constraint is
 * violated stops after one tick.
 */
export function relax(w: World, parts: readonly SimParts[], until: number): Run {
  const { relaxTicks, relaxSpeed } = w.t;
  const still = relaxSpeed * relaxSpeed;
  let ticks = 0, done = true;
  let left = parts.map((p) => ({ p, n: relaxTicks }));
  for (const p of parts) p.constraintsOnly = true;
  outer: while (left.length) {
    for (const e of left) {
      if (now() >= until) { done = false; break outer; }
      for (let k = 0; k < ROUND && e.n > 0; k++) {
        e.p.sim.tick();
        ticks++;
        e.n = maxSpeed2(e.p.nodes) <= still ? 0 : e.n - 1;
      }
    }
    left = left.filter((e) => e.n > 0);
  }
  for (const p of parts) {
    p.constraintsOnly = false;
    for (const n of p.nodes) { n.vx = 0; n.vy = 0; }
  }
  return { ticks, done };
}

/** Close the gaps in a city or district tier: its pull toward the middle against collide, at a steady alpha. */
function squeeze(w: World, parts: readonly SimParts[]): number {
  const { squeezeTicks, squeezeAlpha } = w.t;
  let ticks = 0;
  for (const p of parts) {
    if (p.nodes.length < 2) continue;
    p.constraintsOnly = true;
    p.squeeze = true;
    for (let k = 0; k < squeezeTicks; k++) {
      p.sim.alpha(squeezeAlpha);
      p.sim.tick();
      ticks++;
    }
    p.squeeze = false;
    p.constraintsOnly = false;
    sleep(p.sim);
  }
  return ticks;
}

/** Everything asleep and still, where it is now: this is home (PLAN.md §7.3). */
export function markHome(w: World): void {
  const { districts, files } = simLists(w);
  const home = (nodes: readonly { x: number; y: number; vx: number; vy: number; hx: number; hy: number; hasHome: boolean }[]) => {
    for (const n of nodes) { n.vx = 0; n.vy = 0; n.hx = n.x; n.hy = n.y; n.hasHome = true; }
  };
  sleep(w.cityTier.sim);
  home(w.cityTier.nodes);
  for (const ds of districts) { sleep(ds.sim); home(ds.nodes); }
  for (const fs of files) {
    sleep(fs.sim);
    fs.constraintsOnly = false;
    fs.strayed = false;
    home(fs.nodes);
  }
}

/** Undo whatever an update left in flight: pins, easing radii, constraint runs, the shorter cooling. */
export function endLiveState(w: World): void {
  const { districts, files } = simLists(w);
  snapRadii(w);
  endAllUpdates(w, districts);
  for (const fs of files) {
    if (fs.constraintsOnly) { fs.constraintsOnly = false; sleep(fs.sim); }
    fs.sim.alphaDecay(w.t.alphaDecay);
  }
}

/** Every city's cells exact, and any unit a cell edge cuts off moved straight back in. Returns the simulations touched. */
export function clampToCells(w: World): number {
  const { districts, files } = simLists(w);
  let moved = 0;
  for (const ds of districts) refreshCells(w, ds, 0);
  for (const fs of files) {
    const cell = w.cells[fs.district];
    if (cell && hasStray(fs.nodes, cell, w.t.file.pad) && clampIntoCell(fs.nodes, cell)) { w.pending.files.add(fs); moved++; }
  }
  return moved;
}

export function settleWorld(w: World, maxMs: number): SettleReport {
  const t0 = now(), { t } = w;
  const { districts, files } = simLists(w);
  const city = w.cityTier;
  const first = !w.revealed;
  w.settling = true;
  endLiveState(w);
  let ticks = 0, capped = false;

  // 1. cities, against estimated radii, for bearings
  const activeDistricts = districts.filter((ds) => isHot(ds.sim) || ds.contentDirty);
  if (isHot(city.sim)) {
    let changed = false;
    for (const ds of activeDistricts) {
      const cn = w.cityNodes[ds.city];
      if (cn && cn.r !== ds.estimate) { cn.r = cn.rGoal = cn.bound = ds.estimate; changed = true; }
    }
    if (changed) refreshRadii(city);
    ticks += runToRest([city.sim], Infinity).ticks;
  }

  // 2. districts: laid out, squeezed together, apart by exactly their spacing, centred on their city
  for (const ds of activeDistricts) ds.external.refresh();
  ticks += runToRest(activeDistricts.map((ds) => ds.sim), Infinity).ticks;
  ticks += squeeze(w, activeDistricts);
  ticks += relax(w, activeDistricts, Infinity).ticks;
  for (const ds of activeDistricts) {
    separate(ds.nodes, (a, b) => districtSpacing(a, b, t));
    const c = enclosingCentre(ds.nodes);
    for (const n of ds.nodes) { n.x -= c.x; n.y -= c.y; }
    measureCity(w, ds.city, true);
    ds.contentDirty = false;
  }

  // 3. cities, against measured radii (measureCity reheated the simulation if a radius really changed)
  if (isHot(city.sim)) {
    ticks += runToRest([city.sim], Infinity).ticks;
    ticks += squeeze(w, [city]);
    ticks += relax(w, [city], Infinity).ticks;
  }
  separate(city.nodes, (a, b) => citySpacing(a, b, t));

  // 4. territories
  for (const ds of districts) refreshCells(w, ds, 0);

  // 5. files, into their cells. Before the reveal they have not moved since they were placed on the
  //    district's disc: put them on the same spiral over the cell instead, already evenly spread.
  const activeFiles = files.filter((fs) => isHot(fs.sim));
  if (first) for (const fs of activeFiles) spiralUnits(fs, rankTargets(fs, t), w.seed, w.cells[fs.district]);
  const start = now(), end = Math.max(start, t0 + maxMs * (1 - t.settleReserve));
  const full = runToRest(activeFiles.map((fs) => fs.sim), start + (end - start) * t.settleFullShare);
  const eased = relax(w, activeFiles, end);
  ticks += full.ticks + eased.ticks;
  capped = !full.done || !eased.done;
  clampToCells(w);

  // The map is about to be shown: whatever the cap left unfinished stays where it is.
  markHome(w);
  w.cellsDirty.clear();
  w.settling = false;
  w.revealed = true;
  touchAll(w);
  flush(w);
  const ms = now() - t0;
  return { ms, ticks, atRest: !capped, overlapShare: overlapShare(files.map((fs) => fs.nodes), t.overlapTolerance) };
}
