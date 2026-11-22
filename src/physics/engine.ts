// The in-process physics engine (PhysicsEngine): batches in, position buffers out. It runs in Node
// (pipeline, tests) and inside the physics worker. This file is the scheduler and the commands; the
// tiers, forces, cells, topology, placement, radii and settle each have their own file.
//
// Life of a layout (PLAN.md §6.8):
//   before the reveal   batches build the simulations; nothing ticks, step() does nothing
//   settle()            everything runs to rest in one silent call, home is marked, the map is shown
//   after the reveal    every simulation is asleep. A batch (a user-triggered update) wakes only what
//                       it touches, and the scheduler animates that; relayout() resolves when it is
//                       all asleep again and marks home. A drag wakes one tier.
import { GEN_REV, type PhysicsEngine, type PhysicsInit, type PositionBuffers, type SettleReport, type Vec2 } from '../contracts/physics';
import { parseRef, type LayoutSnapshot, type NodeRef, type PatchBatch } from '../model/types';
import { now } from '../shared';
import { hasStray } from './cells';
import type { DistrictSim } from './districtTier';
import type { FileSim } from './fileTier';
import { coverByRadius, overlapShare } from './quality';
import { clampToCells, endLiveState, markHome, settleWorld } from './settle';
import { countdown, isHot, maxSpeed2, refreshRadii, sleep, type PNode } from './sim';
import { afterTierTick, easeRadii, endUpdate, measureCity } from './space';
import { applyBatchToWorld } from './topology';
import { countHot, createWorld, flush, publishHot, refreshCells, simLists, touchAll } from './world';

export interface PhysicsEngineInternal extends PhysicsEngine {
  /** Units laid out in a district: what the worker copies out when buffers cannot be shared. */
  unitsOf(district: number): readonly { readonly slot: number }[];
  /**
   * The animated counterpart of settle(), for "Apply" and "Update" (PLAN.md §6.8): whatever the batches
   * since the last settle woke runs on the time-sliced scheduler, where the renderer sees it move.
   * Resolves when everything is asleep again, or after `maxMs` (atRest: false), and marks home.
   * Before the first settle it is settle(). In process, the caller keeps calling step().
   */
  relayout(maxMs: number): Promise<SettleReport>;
  /**
   * Layout quality, reported and never asserted: the share of units overlapping another, and how
   * evenly districts are filled from the middle to the edge (see coverByRadius in quality.ts).
   */
  quality(): { overlapShare: number; innerCover: number; middleCover: number; outerCover: number };
}

interface Mover { node: PNode; fromX: number; fromY: number }
interface Reset {
  start: number;
  movers: Mover[];
  /** File simulations whose units are among the movers. */
  files: FileSim[];
  resolve: () => void;
  /** Finishes the reset if nobody is calling step(). */
  timer: ReturnType<typeof setTimeout>;
}
interface Relayout {
  start: number;
  deadline: number;
  ticks: number;
  resolve: (report: SettleReport) => void;
  /** Finishes the re-layout if nobody is calling step(). */
  timer: ReturnType<typeof setTimeout>;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `buffers`: adopt these instead of allocating (the worker writes into buffers the page created). */
export function createEngine(init: PhysicsInit, buffers?: PositionBuffers): PhysicsEngineInternal {
  const w = createWorld(init, buffers);
  const { t } = w;
  let focus: { x: number; z: number; radius: number } | null = null;
  let stepCount = 0;
  let reset: Reset | null = null;
  let relayout: Relayout | null = null;
  /** Things other than hot simulations that still need step() to be called. */
  const waiting = () => (reset ? 1 : 0) + (relayout ? 1 : 0);

  // ---- pins (drag) ----

  /** A simulation holding a pinned node keeps alphaTarget up, which keeps it hot (PLAN.md §7.3). */
  function syncAlphaTargets(): void {
    let cityPinned = false;
    const citiesWithPin = new Set<number>();
    for (const n of w.pins) {
      if (n.parent < 0) cityPinned = true; else citiesWithPin.add(n.parent);
    }
    w.cityTier.sim.alphaTarget(cityPinned ? t.dragAlphaTarget : 0);
    for (const ds of simLists(w).districts) ds.sim.alphaTarget(citiesWithPin.has(ds.city) ? t.dragAlphaTarget : 0);
  }

  function clearPins(): void {
    for (const n of w.pins) { n.fx = null; n.fy = null; }
    w.pins.clear();
    syncAlphaTargets();
  }

  /** The simulation a city or district node lives in. */
  function tierOf(n: PNode) {
    return n.parent < 0 ? w.cityTier : w.districtSims.get(n.parent);
  }

  function findNode(ref: NodeRef): PNode | undefined {
    const { kind, id } = parseRef(ref);
    if (kind === 'city') return w.cityNodes[w.replica.table('city').slotOf(id)];
    if (kind === 'district') return w.districtNodes[w.replica.table('district').slotOf(id)];
    return undefined;
  }

  // ---- reset to home ----

  function isLive(n: PNode): boolean {
    if (n.parent < 0) return w.cityNodes[n.slot] === n;
    return w.districtNodes[n.slot] === n || w.unitNodes[n.slot] === n;
  }

  /** Ease toward home by wall-clock; simulations are not run (PLAN.md §7.3). */
  function advanceReset(time: number): void {
    if (!reset) return;
    const k = Math.min(1, Math.max(0, (time - reset.start) / t.resetMs));
    const e = k * k * (3 - 2 * k);
    for (const m of reset.movers) {
      const n = m.node;
      if (!isLive(n) || !n.hasHome) continue;
      n.x = k >= 1 ? n.hx : m.fromX + (n.hx - m.fromX) * e;
      n.y = k >= 1 ? n.hy : m.fromY + (n.hy - m.fromY) * e;
      n.vx = 0; n.vy = 0;
      if (n.parent < 0) w.pending.city = true;
      else if (w.districtNodes[n.slot] === n) w.pending.districts.add(n);
    }
    for (const fs of reset.files) w.pending.files.add(fs);
    if (k >= 1) endReset();
  }

  function endReset(): void {
    if (!reset) return;
    const done = reset;
    reset = null;
    clearTimeout(done.timer);
    // districts moved without ticking: their cells follow, and anything a cell now cuts off is brought in
    for (const ds of simLists(w).districts) w.cellsDirty.add(ds);
    done.resolve();
  }

  // ---- re-layout ----

  /** Mark home and report. `forced`: time ran out, so what is still moving is stopped where it is. */
  function endRelayout(): void {
    if (!relayout) return;
    const done = relayout;
    relayout = null;
    clearTimeout(done.timer);
    const atRest = countHot(w) === 0 && w.easing.size === 0;
    const { districts, files } = simLists(w);
    if (!atRest) {
      endLiveState(w);
      for (const ds of districts) for (const n of ds.nodes) w.pending.districts.add(n);
      clampToCells(w);
      w.cellsDirty.clear();
      w.pending.city = true;
    }
    markHome(w);
    flush(w);
    publishHot(w, waiting());
    done.resolve({ ms: now() - done.start, ticks: done.ticks, atRest, overlapShare: overlapShare(files.map((fs) => fs.nodes), t.overlapTolerance) });
  }

  function isAtHome(): boolean {
    for (const n of w.cityTier.nodes) if (n.hasHome && (n.x !== n.hx || n.y !== n.hy)) return false;
    for (const ds of simLists(w).districts) {
      for (const n of ds.nodes) if (n.hasHome && (n.x !== n.hx || n.y !== n.hy)) return false;
    }
    return true;
  }

  // ---- cells ----

  /**
   * Keep the cells of cities whose districts or outline moved this slice current (to cellEps while
   * they are moving, exactly once they stop). When a city's districts have come to rest, any unit a
   * cell edge now cuts off is brought back inside by its file simulation, on constraints alone.
   */
  function followCells(): void {
    for (const ds of w.cellsDirty) {
      if (w.districtSims.get(ds.city) !== ds) { w.cellsDirty.delete(ds); continue; }
      const moving = isHot(ds.sim) || !!reset || ds.nodes.some((n) => w.easing.has(n));
      refreshCells(w, ds, moving ? t.district.cellEps : 0);
      if (moving) continue;
      w.cellsDirty.delete(ds);
      for (const n of ds.nodes) {
        const fs = w.fileSims.get(n.slot), cell = w.cells[n.slot];
        if (!fs || !cell || isHot(fs.sim) || !hasStray(fs.nodes, cell, t.file.pad)) continue;
        fs.constraintsOnly = true;
        fs.strayed = true;
        countdown(fs.sim, t.relaxTicks);
      }
    }
  }

  // ---- scheduler ----

  /** Hot file simulations, nearest the camera focus first. */
  function hotFiles(files: readonly FileSim[]): FileSim[] {
    const hot = files.filter((fs) => isHot(fs.sim));
    if (!focus) return hot;
    for (const fs of hot) {
      const dn = w.districtNodes[fs.district];
      const cn = dn && w.cityNodes[dn.parent];
      if (!dn || !cn) { fs.focusDist = Infinity; continue; }
      const dx = cn.x + dn.x - focus.x, dy = cn.y + dn.y - focus.z;
      fs.focusDist = Math.max(0, Math.sqrt(dx * dx + dy * dy) - dn.r);
    }
    return hot.sort((a, b) => a.focusDist - b.focusDist || a.district - b.district);
  }

  function tickTier(tier: DistrictSim | typeof w.cityTier): void {
    tier.sim.tick();
    if (relayout) relayout.ticks++;
    afterTierTick(w, tier);
  }

  /**
   * One tick of a file simulation, and what follows when it cools: a run on its constraints alone
   * (collide and its cell) until nothing moves, as in the pre-reveal settle, and only then sleep.
   */
  function tickFile(fs: FileSim): void {
    fs.sim.tick();
    if (relayout) relayout.ticks++;
    fs.ticked = stepCount;
    w.pending.files.add(fs);
    if (fs.constraintsOnly) {
      if (maxSpeed2(fs.nodes) <= t.relaxSpeed * t.relaxSpeed) sleep(fs.sim);
      if (!isHot(fs.sim)) fs.constraintsOnly = false;
    } else if (!isHot(fs.sim) && t.relaxTicks > 0) {
      fs.constraintsOnly = true;
      countdown(fs.sim, t.relaxTicks);
    }
  }

  /**
   * One slice: each hot simulation ticks once, city first, then districts, then files by distance to
   * the focus, until the slice is used; what is left waits for the next slice. A tick cannot be split,
   * so one very large file simulation can overrun the slice. Before the reveal nothing runs.
   */
  function step(maxMs: number): number {
    if (!w.revealed) return 0;
    const t0 = now();
    stepCount++;
    if (reset) advanceReset(t0);
    easeRadii(w);
    const { districts, files } = simLists(w);

    if (isHot(w.cityTier.sim)) {
      tickTier(w.cityTier);
      w.pending.city = true;
    }
    let spent = false;
    for (const ds of districts) {
      if (!isHot(ds.sim)) continue;
      if (now() - t0 >= maxMs) { spent = true; break; }
      tickTier(ds);
      ds.ticked = stepCount;
      w.cellsDirty.add(ds);
      for (const n of ds.nodes) w.pending.districts.add(n);
    }
    if (!spent) {
      for (const fs of hotFiles(files)) {
        if (now() - t0 >= maxMs) break;
        // file simulations outside the focus radius run at a reduced rate
        if (focus && fs.focusDist > focus.radius && stepCount % t.offFocusEvery !== 0) continue;
        tickFile(fs);
      }
    }

    // A city's radius follows its districts (a district's follows its content, eased: easeRadii), and
    // each change wakes the city tier so neighbours make room (space.ts). At rest it is measured exactly.
    for (const ds of districts) {
      if (!ds.contentDirty) continue;
      const hot = isHot(ds.sim);
      if (hot && ds.ticked !== stepCount) continue;
      measureCity(w, ds.city, !hot);
      if (!hot) ds.contentDirty = false;
    }
    if (w.cellsDirty.size) followCells();

    flush(w);
    if (relayout && (now() >= relayout.deadline || (countHot(w) === 0 && w.easing.size === 0 && !reset))) endRelayout();
    return publishHot(w, waiting());
  }

  // ---- the API ----

  const engine: PhysicsEngineInternal = {
    get positions() { return w.positions; },
    onBuffers(fn) {
      w.bufferListeners.add(fn);
      return () => { w.bufferListeners.delete(fn); };
    },

    applyBatch(batch: PatchBatch) {
      applyBatchToWorld(w, batch);
      syncAlphaTargets(); // a pinned node may have gone
      flush(w);
      Atomics.store(w.positions.gen, GEN_REV, w.replica.rev);
      publishHot(w, waiting());
    },

    async settle(maxMs: number): Promise<SettleReport> {
      endReset();
      clearPins();
      const report = settleWorld(w, maxMs);
      endRelayout(); // a re-layout in flight has nothing left to wait for
      publishHot(w);
      return report;
    },

    relayout(maxMs: number): Promise<SettleReport> {
      if (!w.revealed) return engine.settle(maxMs);
      endReset();
      endRelayout();
      clearPins();
      return new Promise<SettleReport>((resolve) => {
        const start = now();
        const cap = finite(maxMs) ? Math.max(0, maxMs) : 0;
        // a caller that stops calling step() still gets an answer, a little after the cap
        const timer = setTimeout(() => { endRelayout(); }, cap + 250);
        relayout = { start, deadline: start + cap, ticks: 0, resolve, timer };
        publishHot(w, waiting());
      });
    },

    step,

    drag(ref: NodeRef, x: number, z: number) {
      const n = findNode(ref);
      if (!n || !finite(x) || !finite(z) || !w.revealed) return;
      endReset();
      // a drag takes the tier over from an update: no pins but the dragged node's, and the full forces
      const tier = tierOf(n);
      if (tier && !w.pins.has(n)) {
        endUpdate(w, tier);
        if (!isHot(tier.sim)) tier.sim.alphaDecay(t.alphaDecay);
      }
      if (n.parent < 0) {
        n.fx = x; n.fy = z;
      } else {
        // world → city-local, kept inside the city's territory
        const cn = w.cityNodes[n.parent];
        if (!cn || !w.districtSims.has(n.parent)) return;
        let lx = x - cn.x, ly = z - cn.y;
        const lim = Math.max(0, cn.r - n.bound);
        const d = Math.sqrt(lx * lx + ly * ly);
        if (d > lim) { const k = d > 0 ? lim / d : 0; lx *= k; ly *= k; }
        n.fx = lx; n.fy = ly;
      }
      w.pins.add(n);
      syncAlphaTargets();
      publishHot(w, waiting());
    },

    release(ref: NodeRef) {
      const n = findNode(ref);
      if (!n || !w.pins.delete(n)) return;
      n.fx = null; n.fy = null;
      syncAlphaTargets();
      publishHot(w, waiting());
    },

    resetLayout(): Promise<void> {
      endReset();
      clearPins();
      if (!w.revealed) return Promise.resolve();
      endLiveState(w);
      const { districts, files } = simLists(w);
      sleep(w.cityTier.sim);
      for (const ds of districts) sleep(ds.sim);
      const movers: Mover[] = [];
      const add = (n: PNode) => {
        n.vx = 0; n.vy = 0;
        if (n.hasHome && (n.x !== n.hx || n.y !== n.hy)) movers.push({ node: n, fromX: n.x, fromY: n.y });
      };
      for (const n of w.cityTier.nodes) add(n);
      for (const ds of districts) for (const n of ds.nodes) add(n);
      // units have a home only for this: a cell edge moved by a drag pushed them, and they go back with it
      const strayed = files.filter((fs) => fs.strayed);
      for (const fs of strayed) {
        sleep(fs.sim);
        fs.constraintsOnly = false;
        fs.strayed = false;
        for (const n of fs.nodes) add(n);
      }
      if (!movers.length) {
        publishHot(w, waiting());
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          advanceReset(Infinity);
          followCells();
          flush(w);
          publishHot(w, waiting());
        }, t.resetMs + 250);
        reset = { start: now(), movers, files: strayed, resolve, timer };
        publishHot(w, waiting());
      });
    },

    isAtHome,

    setFocus(target: Vec2, radius: number) {
      focus = finite(target.x) && finite(target.z) ? { x: target.x, z: target.z, radius: finite(radius) ? radius : Infinity } : null;
    },

    async getLayout(): Promise<LayoutSnapshot> {
      const out: LayoutSnapshot = { unit: { ids: [], xz: [] }, district: { ids: [], xzr: [] }, city: { ids: [], xzr: [] }, home: { district: [], city: [] } };
      const f = Math.fround; // what the buffers hold
      for (const n of w.unitNodes) {
        if (!n) continue;
        out.unit.ids.push(n.id);
        out.unit.xz.push(f(n.x), f(n.y));
      }
      for (const n of w.districtNodes) {
        if (!n) continue;
        out.district.ids.push(n.id);
        out.district.xzr.push(f(n.x), f(n.y), f(n.bound));
        out.home.district.push(f(n.hasHome ? n.hx : n.x), f(n.hasHome ? n.hy : n.y));
      }
      for (const n of w.cityNodes) {
        if (!n) continue;
        out.city.ids.push(n.id);
        out.city.xzr.push(f(n.x), f(n.y), f(n.r));
        out.home.city.push(f(n.hasHome ? n.hx : n.x), f(n.hasHome ? n.hy : n.y));
      }
      return out;
    },

    loadLayout(layout: LayoutSnapshot) {
      endReset();
      clearPins();
      endLiveState(w);
      const units = w.replica.table('unit'), districtTable = w.replica.table('district'), cityTable = w.replica.table('city');
      const place = (n: PNode | undefined, x: number, y: number): n is PNode => {
        if (!n || !finite(x) || !finite(y)) return false;
        n.x = x; n.y = y; n.vx = 0; n.vy = 0; n.placed = true;
        return true;
      };
      const area = (n: PNode, r: number, home: number[], i: number) => {
        // a district's saved radius is its bound; its own radius comes from its content, as always
        if (finite(r) && r > 0) {
          if (n.parent < 0) { n.r = n.rGoal = n.bound = r; n.measured = true; } else n.bound = r;
        }
        const hx = home[2 * i], hy = home[2 * i + 1];
        n.hx = finite(hx) ? hx : n.x;
        n.hy = finite(hy) ? hy : n.y;
        n.hasHome = true;
      };
      layout.unit.ids.forEach((id, i) => { place(w.unitNodes[units.slotOf(id)], layout.unit.xz[2 * i], layout.unit.xz[2 * i + 1]); });
      layout.district.ids.forEach((id, i) => {
        const n = w.districtNodes[districtTable.slotOf(id)], a = layout.district.xzr;
        if (place(n, a[3 * i], a[3 * i + 1])) area(n, a[3 * i + 2], layout.home.district, i);
      });
      layout.city.ids.forEach((id, i) => {
        const n = w.cityNodes[cityTable.slotOf(id)], a = layout.city.xzr;
        if (place(n, a[3 * i], a[3 * i + 1])) area(n, a[3 * i + 2], layout.home.city, i);
      });
      // Everything is left asleep, with containment sized to the loaded territories. Where a unit is
      // now is its home, should a cell edge ever push it (the snapshot keeps homes for cities and districts).
      const { districts, files } = simLists(w);
      for (const fs of files) {
        sleep(fs.sim);
        fs.constraintsOnly = false;
        fs.strayed = false;
        for (const n of fs.nodes) { n.hx = n.x; n.hy = n.y; n.hasHome = true; }
      }
      for (const ds of districts) {
        sleep(ds.sim);
        ds.contentDirty = false;
        refreshRadii(ds);
        const cn = w.cityNodes[ds.city];
        if (cn?.measured) ds.containR = Math.max(0, cn.r - t.district.pad);
        ds.cells = null;
        refreshCells(w, ds, 0);
      }
      sleep(w.cityTier.sim);
      refreshRadii(w.cityTier);
      w.cellsDirty.clear();
      w.revealed = true;
      endRelayout();
      touchAll(w);
      flush(w);
      publishHot(w, waiting());
    },

    unitsOf(district: number) {
      return w.fileSims.get(district)?.nodes ?? [];
    },

    quality() {
      const { districts, files } = simLists(w);
      for (const ds of districts) refreshCells(w, ds, 0);
      return {
        overlapShare: overlapShare(files.map((fs) => fs.nodes), t.overlapTolerance),
        ...coverByRadius(files.map((fs) => ({ nodes: fs.nodes, cell: w.cells[fs.district] }))),
      };
    },

    dispose() {
      endReset();
      if (relayout) { clearTimeout(relayout.timer); relayout = null; }
      w.pins.clear();
      w.bufferListeners.clear();
    },
  };
  return engine;
}
