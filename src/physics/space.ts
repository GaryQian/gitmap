// Radii, and how a change in one travels (PLAN.md §7.1 "Space propagates upward"; IMPLEMENTATION.md §4
// "pin unaffected cities and districts").
//
// A district's radius is the disc that holds its content packed (fileTier.ts); a city's is measured
// from where its districts are. Before the reveal, and inside settle(), a new radius applies at once.
// Afterwards it is a goal the radius eases toward, a share of the difference per slice, and each step
// of that wakes the tier the node lives in:
//
//   district content grows → its radius eases up → the city's district simulation makes room
//   → the city's radius eases up → the city simulation makes room.
//
// "Makes room" is deliberately narrow. A tier woken this way runs on collide alone, every node the
// change did not touch is pinned (fx/fy) where it stands, and a pinned node is let go only when a free
// one is pushed into it. So room is made where it is needed and nothing else moves: a city that no
// growing neighbour reaches stays exactly where it was. A tier woken because its membership changed
// (a new district, a new city) runs its full forces on the free nodes, with the same pins.
// When the simulation is back at rest the pins are cleared.
import { citySpacing } from './cityTier';
import { districtBound, districtSpacing, estimateCityRadius, type DistrictSim } from './districtTier';
import { separate } from './forces';
import { countdown, enclosingRadius, heatFor, isHot, maxSpeed2, refreshRadii, reheat, type PNode, type SimParts } from './sim';
import type { World } from './world';

/**
 * Two bodies count as pushed together when they are closer than their spacing by more than this share
 * of it: beyond what positions lose on their way through a Float32 snapshot, and nothing one would see.
 */
const TOUCH = 1e-5;

function significant(w: World, before: number, after: number): boolean {
  return Math.abs(after - before) > Math.max(w.t.radiusEpsAbs, w.t.radiusEpsRel * before);
}

/** After the reveal and outside settle(): changes are shown, so they ease and stay local. */
function live(w: World): boolean {
  return w.revealed && !w.settling;
}

function tierOf(w: World, n: PNode): SimParts | undefined {
  return n.parent < 0 ? w.cityTier : w.districtSims.get(n.parent);
}

function isLive(w: World, n: PNode): boolean {
  return (n.parent < 0 ? w.cityNodes[n.slot] : w.districtNodes[n.slot]) === n;
}

// ---- radii ----

/** Give a district or city this radius now, and tell its tier. */
export function setRadius(w: World, n: PNode, r: number): void {
  n.r = r;
  if (n.parent < 0) {
    n.bound = r;
    w.pending.city = true;
    refreshRadii(w.cityTier);
    return;
  }
  n.bound = districtBound(r, w.t);
  w.pending.districts.add(n);
  const ds = w.districtSims.get(n.parent);
  if (!ds) return;
  w.cellsDirty.add(ds); // a district's size is its weight in the cells
  refreshRadii(ds);
  ds.estimate = estimateCityRadius(ds.nodes, w.t);
  ds.containR = Math.max(ds.estimate, enclosingRadius(ds.nodes));
  ds.contentDirty = true;
}

/** A node's content asks for a new radius. `wake`: the change is large enough for its siblings to make room. */
function retarget(w: World, n: PNode, goal: number, wake: boolean): void {
  n.rGoal = goal;
  n.measured = true;
  if (live(w) && wake) { w.easing.add(n); return; }
  w.easing.delete(n);
  setRadius(w, n, goal);
  const tier = tierOf(w, n);
  if (wake && tier) reheat(tier.sim, w.t.reheat);
}

/**
 * A district's content changed and asks for radius `r`. After the reveal a change large enough for the
 * siblings to notice eases in; anything else applies at once. Returns true when it was applied at once.
 */
export function resizeDistrict(w: World, dn: PNode, r: number): boolean {
  if (live(w) && dn.placed && significant(w, dn.r, r)) {
    dn.rGoal = r;
    w.easing.add(dn);
    return false;
  }
  dn.rGoal = r;
  w.easing.delete(dn);
  setRadius(w, dn, r);
  return true;
}

/** A city's radius from where its districts are now: the circle that encloses their discs, plus pad. */
export function measureCity(w: World, c: number, exact: boolean): void {
  const cn = w.cityNodes[c];
  if (!cn) return;
  const ds = w.districtSims.get(c);
  const enclosing = ds ? enclosingRadius(ds.nodes) : 0;
  if (exact && ds) ds.containR = enclosing;
  const goal = enclosing + w.t.district.pad;
  const big = significant(w, cn.rGoal, goal);
  if (exact) cn.measured = true;
  if (big || (exact && goal !== cn.rGoal)) retarget(w, cn, goal, big);
}

/** One slice of easing: every radius on its way to a goal covers a share of what is left, and its tier makes room. */
export function easeRadii(w: World): void {
  for (const n of [...w.easing]) {
    if (!isLive(w, n)) { w.easing.delete(n); continue; }
    const left = n.rGoal - n.r;
    const done = Math.abs(left) <= w.t.radiusEpsAbs * w.t.radiusEase;
    if (done) w.easing.delete(n);
    setRadius(w, n, done ? n.rGoal : n.r + left * w.t.radiusEase);
    const tier = tierOf(w, n);
    if (tier) wakeTier(w, tier, [n], false);
  }
}

/** Finish every easing radius at once (before a settle, a reset, or when a re-layout runs out of time). */
export function snapRadii(w: World): void {
  for (const n of w.easing) if (isLive(w, n)) setRadius(w, n, n.rGoal);
  w.easing.clear();
}

// ---- waking a city or district tier for an update ----

function letGo(tier: SimParts, n: PNode): void {
  if (tier.held.delete(n)) { n.fx = null; n.fy = null; }
}

/**
 * Wake a city or district simulation because `touched` changed. If it was asleep, every other node is
 * pinned first. `full`: membership changed, so the free nodes get the tier's full forces at a gentle
 * alpha; otherwise only collide acts.
 */
export function wakeTier(w: World, tier: SimParts, touched: Iterable<PNode>, full: boolean): void {
  const { t } = w;
  const hot = isHot(tier.sim);
  if (!hot) {
    for (const n of tier.nodes) {
      if (n.fx == null) { n.fx = n.x; n.fy = n.y; tier.held.add(n); }
    }
  }
  for (const n of touched) letGo(tier, n);
  const wasFull = hot && !tier.constraintsOnly;
  if (full || wasFull) {
    tier.constraintsOnly = false;
    if (full) heatFor(tier.sim, wasFull ? Math.max(tier.sim.alpha(), t.reheat) : t.reheat, t.updateTicks);
  } else {
    tier.constraintsOnly = true;
    tier.budget = t.relaxTicks;
    countdown(tier.sim, t.pushTicks);
  }
}

/**
 * Clear an update's pins and put the tier back on its full forces. Cities that made room for one
 * another did so by a force, to a tolerance: they are set apart exactly here, so the gap between two
 * cities stays a hard minimum after an update as it is after the settle.
 */
export function endUpdate(w: World, tier: SimParts): void {
  if (tier === w.cityTier && (tier.held.size || tier.constraintsOnly) && live(w)) {
    const pinned = tier.nodes.filter((n) => n.fx != null && !tier.held.has(n)); // held by a drag: they stay put
    for (const n of tier.held) { n.fx = null; n.fy = null; }
    if (!pinned.length) { separate(tier.nodes, (a, b) => citySpacing(a, b, w.t)); w.pending.city = true; }
  }
  for (const n of tier.held) { n.fx = null; n.fy = null; }
  tier.held.clear();
  // on constraints alone alpha was only a countdown: it must not carry over to the full forces
  if (tier.constraintsOnly) tier.sim.alpha(0);
  tier.constraintsOnly = false;
  tier.sim.alphaDecay(w.t.alphaDecay);
}

/**
 * After each tick of a city or district simulation: let go of pinned nodes a free one has been pushed
 * into, keep a constraints-only run awake while it is still moving, and end the update at rest.
 */
export function afterTierTick(w: World, tier: SimParts): void {
  const { t } = w;
  if (tier.held.size) {
    const city = tier === w.cityTier;
    for (const h of [...tier.held]) {
      for (const f of tier.nodes) {
        if (f === h || tier.held.has(f)) continue;
        const d = city ? citySpacing(f, h, t) : districtSpacing(f, h, t);
        const dx = f.x - h.x, dy = f.y - h.y;
        const reach = d * (1 - TOUCH);
        if (dx * dx + dy * dy < reach * reach) { letGo(tier, h); break; }
      }
    }
  }
  if (tier.constraintsOnly && tier.budget-- > 0 && maxSpeed2(tier.nodes) > t.relaxSpeed * t.relaxSpeed) countdown(tier.sim, t.pushTicks);
  if (!isHot(tier.sim)) endUpdate(w, tier);
}

/** Every pin of every update, cleared (before a settle, a reset or a drag takes over). */
export function endAllUpdates(w: World, districts: readonly DistrictSim[]): void {
  endUpdate(w, w.cityTier);
  for (const ds of districts) endUpdate(w, ds);
}
