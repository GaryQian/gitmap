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
//   5. file simulations            → each district's units spread over its cell: cooled on all
//                                     forces, spread to the cell's edge, relaxed on constraints
//   6. last pass                   → any two spheres still closer than their radii plus the pad are
//                                     moved apart directly
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
// forces (on a shorter cooling schedule if the full one would not fit), the rest for spreading and
// relaxation, and what settleReserve keeps back for the last pass. The city and district tiers are a
// few dozen small simulations costing milliseconds and always run to rest. Units start on a spiral
// over their cell that is already evenly spread, so however short the cap falls, cities and districts
// do not overlap and every unit is inside its district's cell; what the cap costs is a coarser
// arrangement and, on very large models, overlap between units, reported with atRest: false.
//
// Nothing here depends on the clock except the cap, and simulations of a tier are independent, so the
// same batches and seed give the same layout whenever the cap is not reached.
import type { SettleReport } from '../contracts/physics';
import { now } from '../shared';
import { clampIntoCell, hasStray } from './cells';
import { citySpacing } from './cityTier';
import { districtSpacing, enclosingCentre } from './districtTier';
import { rankTargets, type FileSim } from './fileTier';
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
 * The file tier's full forces under the cap. After one round the cost of a round is known; if cooling
 * over physics.settleTicks would overrun `until`, every simulation is put on a faster schedule that
 * does finish in the time left. A shorter cooling from an even start gives a coarser but whole layout;
 * a full-length cooling cut off part-way leaves the link force's clumps in place with nothing to undo
 * them. `done` is false when the schedule was shortened or cut.
 */
function runFiles(w: World, sims: Sim[], until: number): Run {
  const { alphaMin, alphaDecay } = w.t;
  let hot = sims.filter(isHot);
  if (!hot.length) return { ticks: 0, done: true };
  // two rounds, and the cheaper of the two: the first also pays for the engine warming up
  let ticks = 0, round = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    const t0 = now();
    for (const sim of hot) {
      if (now() >= until) break;
      for (let k = 0; k < ROUND && isHot(sim); k++) { sim.tick(); ticks++; }
    }
    round = Math.min(round, Math.max(1e-3, now() - t0));
    hot = hot.filter(isHot);
  }
  let need = 0;
  for (const sim of hot) need = Math.max(need, Math.log(alphaMin / sim.alpha()) / Math.log(1 - alphaDecay));
  const afford = Math.floor((until - now()) / round) * ROUND;
  const shortened = afford < need;
  if (shortened) {
    for (const sim of hot) sim.alphaDecay(1 - Math.pow(Math.min(1, alphaMin / sim.alpha()), 1 / Math.max(ROUND, afford)));
  }
  const rest = runToRest(hot, until);
  if (shortened) for (const sim of sims) sim.alphaDecay(alphaDecay);
  return { ticks: ticks + rest.ticks, done: rest.done && !shortened };
}

/**
 * Run simulations on their constraints alone until nothing in them moves faster than relaxSpeed, for at
 * most relaxTicks ticks each, or until the clock passes `until`. A simulation in which no constraint is
 * violated stops after one tick.
 */
export function relax(w: World, parts: readonly SimParts[], until: number, maxTicks = w.t.relaxTicks): Run {
  const still = w.t.relaxSpeed * w.t.relaxSpeed;
  let ticks = 0, done = true;
  let left = parts.map((p) => ({ p, n: maxTicks }));
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

/**
 * The file tier's last pass: no two spheres of a district closer than their radii plus the pad.
 * Relaxation by force stops when nothing moves faster than relaxSpeed, which leaves the odd pair a
 * little inside each other, and a capped settle may not get that far at all. Here the collide discs
 * are the sphere plus half the pad, and each round moves every overlapping pair apart by the full
 * overlap, directly, then puts anything pushed across a cell edge back inside. A district with no pair
 * that close is done after one round. Runs until `until`, in rounds over all districts.
 */
function finish(w: World, files: readonly FileSim[], until: number): void {
  let left = files.filter((fs) => fs.nodes.length > 1).map((fs) => ({ fs, n: w.t.file.finishRounds }));
  for (const { fs } of left) { fs.tight = true; fs.collide.refresh(); }
  const all = left;
  while (left.length && now() < until) {
    for (const e of left) {
      const { fs } = e;
      for (const n of fs.nodes) { n.vx = 0; n.vy = 0; }
      fs.collide(1);
      let moved = false;
      for (const n of fs.nodes) {
        if (n.vx === 0 && n.vy === 0) continue;
        n.x += n.vx; n.y += n.vy;
        n.vx = 0; n.vy = 0;
        moved = true;
      }
      const cell = w.cells[fs.district];
      if (moved && cell) clampIntoCell(fs.nodes, cell);
      e.n = moved ? e.n - 1 : 0;
    }
    left = left.filter((e) => e.n > 0);
  }
  for (const { fs } of all) { fs.tight = false; fs.collide.refresh(); }
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
  const full = runFiles(w, activeFiles.map((fs) => fs.sim), start + (end - start) * t.settleFullShare);
  // spread to the edge of the territory, then settle on collide and containment alone
  for (const fs of activeFiles) fs.spreading = true;
  ticks += relax(w, activeFiles, start + (end - start) * (1 + t.settleFullShare) / 2, t.file.spreadTicks).ticks;
  for (const fs of activeFiles) fs.spreading = false;
  const eased = relax(w, activeFiles, end);
  ticks += full.ticks + eased.ticks;
  capped = !full.done || !eased.done;
  clampToCells(w);
  finish(w, activeFiles, t0 + maxMs);

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
