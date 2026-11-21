// The pre-reveal settle (PLAN.md §6.8, §7.2): run every hot simulation to rest with no rendering,
// under a time cap, then mark home.
//
// Order. Radii are measured from settled content, so each tier is laid out against the real size of
// the tier below it:
//   1. file simulations            → each district's radius = enclosing radius of its spheres + pad
//   2. city simulation, first pass → gives districts a bearing toward the cities they depend on;
//                                     city radii are still area estimates here
//   3. district simulations        → each city's radius = enclosing radius of its districts + pad
//   4. city simulation, again      → cities make room for the measured radii
// The spike settled city → district → file because it took radii from an area formula alone; the
// measured radii need the lower tier first. Passes 2–4 are a few dozen small simulations and cost
// milliseconds; the file tier is nearly all of the time, so part of the cap is kept back for them.
//
// Nothing here depends on the clock except the cap, and simulations of a tier are independent, so the
// same batches and seed give the same layout whenever the cap is not reached.
import type { SettleReport } from '../contracts/physics';
import { now } from '../shared';
import { overlapShare } from './quality';
import { isHot, refreshRadii, sleep, type Sim } from './sim';
import { countHot, flush, measureCity, measureDistrict, simLists, touchAll, type World } from './world';

/** Ticks given to one simulation before moving to the next, so a cap cuts every simulation equally short. */
const ROUND = 10;

function runToRest(sims: Sim[], until: number): number {
  let ticks = 0;
  let hot = sims.filter(isHot);
  while (hot.length) {
    for (const sim of hot) {
      if (now() >= until) return ticks;
      for (let k = 0; k < ROUND && isHot(sim); k++) { sim.tick(); ticks++; }
    }
    hot = hot.filter(isHot);
  }
  return ticks;
}

export function settleWorld(w: World, maxMs: number): SettleReport {
  const t0 = now();
  const deadline = t0 + maxMs;
  const { districts, files } = simLists(w);
  const city = w.cityTier;
  let ticks = 0;

  // 1. files
  const activeFiles = files.filter((fs) => isHot(fs.sim) || fs.contentDirty);
  ticks += runToRest(activeFiles.map((fs) => fs.sim), t0 + maxMs * (1 - w.t.settleReserve));
  for (const fs of activeFiles) {
    measureDistrict(w, fs.district, true);
    fs.contentDirty = false;
  }

  // 2. cities, against estimated radii, for bearings
  if (isHot(city.sim)) {
    let changed = false;
    for (const ds of districts) {
      const cn = w.cityNodes[ds.city];
      if (cn && (isHot(ds.sim) || ds.contentDirty) && cn.r !== ds.estimate) { cn.r = ds.estimate; changed = true; }
    }
    if (changed) refreshRadii(city);
    ticks += runToRest([city.sim], deadline);
  }

  // 3. districts
  const activeDistricts = districts.filter((ds) => isHot(ds.sim) || ds.contentDirty);
  for (const ds of activeDistricts) ds.external.refresh();
  ticks += runToRest(activeDistricts.map((ds) => ds.sim), deadline);
  for (const ds of activeDistricts) {
    measureCity(w, ds.city, true);
    ds.contentDirty = false;
  }

  // 4. cities, against measured radii (measureCity reheated the simulation if a radius really changed)
  ticks += runToRest([city.sim], deadline);

  // The map is about to be shown: whatever the cap left unfinished stays where it is.
  const atRest = countHot(w) === 0;
  sleep(city.sim);
  for (const n of city.nodes) { n.vx = 0; n.vy = 0; n.hx = n.x; n.hy = n.y; n.hasHome = true; }
  for (const ds of districts) {
    sleep(ds.sim);
    for (const n of ds.nodes) { n.vx = 0; n.vy = 0; n.hx = n.x; n.hy = n.y; n.hasHome = true; }
  }
  for (const fs of files) {
    sleep(fs.sim);
    for (const n of fs.nodes) { n.vx = 0; n.vy = 0; }
  }
  touchAll(w);
  flush(w);
  const ms = now() - t0;
  return { ms, ticks, atRest, overlapShare: overlapShare(files.map((fs) => fs.nodes), w.t.overlapTolerance) };
}
