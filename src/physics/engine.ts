// The in-process physics engine (PhysicsEngine): batches in, position buffers out. It runs in Node
// (pipeline, tests) and inside the physics worker. This file is the scheduler and the commands; the
// tiers, forces, topology, placement and settle each have their own file.
import { GEN_REV, type PhysicsEngine, type PhysicsInit, type PositionBuffers, type SettleReport, type Vec2 } from '../contracts/physics';
import { parseRef, type LayoutSnapshot, type NodeRef, type PatchBatch } from '../model/types';
import { now } from '../shared';
import type { FileSim } from './fileTier';
import { settleWorld } from './settle';
import { isHot, refreshRadii, sleep, type PNode } from './sim';
import { applyBatchToWorld } from './topology';
import { createWorld, flush, measureCity, measureDistrict, publishHot, simLists, touchAll } from './world';

export interface PhysicsEngineInternal extends PhysicsEngine {
  /** Units laid out in a district: what the worker copies out when buffers cannot be shared. */
  unitsOf(district: number): readonly { readonly slot: number }[];
}

interface Mover { node: PNode; fromX: number; fromY: number }
interface Reset {
  start: number;
  movers: Mover[];
  resolve: () => void;
  /** Finishes the reset if nobody is calling step(). */
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

  function findNode(ref: NodeRef): PNode | undefined {
    const { kind, id } = parseRef(ref);
    if (kind === 'city') return w.cityNodes[w.replica.table('city').slotOf(id)];
    if (kind === 'district') return w.districtNodes[w.replica.table('district').slotOf(id)];
    return undefined;
  }

  // ---- reset to home ----

  function isLive(n: PNode): boolean {
    return (n.parent < 0 ? w.cityNodes[n.slot] : w.districtNodes[n.slot]) === n;
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
      if (n.parent < 0) w.pending.city = true; else w.pending.districts.add(n);
    }
    if (k >= 1) endReset();
  }

  function endReset(): void {
    if (!reset) return;
    const done = reset;
    reset = null;
    clearTimeout(done.timer);
    done.resolve();
  }

  function isAtHome(): boolean {
    for (const n of w.cityTier.nodes) if (n.hasHome && (n.x !== n.hx || n.y !== n.hy)) return false;
    for (const ds of simLists(w).districts) {
      for (const n of ds.nodes) if (n.hasHome && (n.x !== n.hx || n.y !== n.hy)) return false;
    }
    return true;
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

  /**
   * One slice: each hot simulation ticks once, city first, then districts, then files by distance to
   * the focus, until the slice is used; what is left waits for the next slice. A tick cannot be split,
   * so one very large file simulation can overrun the slice.
   */
  function step(maxMs: number): number {
    const t0 = now();
    stepCount++;
    if (reset) advanceReset(t0);
    const { districts, files } = simLists(w);

    if (isHot(w.cityTier.sim)) {
      w.cityTier.sim.tick();
      w.pending.city = true;
    }
    let spent = false;
    for (const ds of districts) {
      if (!isHot(ds.sim)) continue;
      if (now() - t0 >= maxMs) { spent = true; break; }
      ds.sim.tick();
      ds.ticked = stepCount;
      for (const n of ds.nodes) w.pending.districts.add(n);
    }
    if (!spent) {
      for (const fs of hotFiles(files)) {
        if (now() - t0 >= maxMs) break;
        // file simulations outside the focus radius run at a reduced rate
        if (focus && fs.focusDist > focus.radius && stepCount % t.offFocusEvery !== 0) continue;
        fs.sim.tick();
        fs.ticked = stepCount;
        w.pending.files.add(fs);
      }
    }

    // Radii follow content: a district grows with its units, its city with its districts, and each
    // change warms the tier above so siblings make room. At rest the radius is measured exactly.
    for (const fs of files) {
      if (!fs.contentDirty) continue;
      const hot = isHot(fs.sim);
      if (hot && fs.ticked !== stepCount) continue;
      measureDistrict(w, fs.district, !hot);
      if (!hot) fs.contentDirty = false;
    }
    for (const ds of districts) {
      if (!ds.contentDirty) continue;
      const hot = isHot(ds.sim);
      if (hot && ds.ticked !== stepCount) continue;
      measureCity(w, ds.city, !hot);
      if (!hot) ds.contentDirty = false;
    }

    flush(w);
    return publishHot(w, reset ? 1 : 0);
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
      publishHot(w, reset ? 1 : 0);
    },

    async settle(maxMs: number): Promise<SettleReport> {
      endReset();
      clearPins();
      const report = settleWorld(w, maxMs);
      publishHot(w);
      return report;
    },

    step,

    drag(ref: NodeRef, x: number, z: number) {
      const n = findNode(ref);
      if (!n || !finite(x) || !finite(z)) return;
      endReset();
      if (n.parent < 0) {
        n.fx = x; n.fy = z;
      } else {
        // world → city-local, kept inside the city's territory
        const cn = w.cityNodes[n.parent];
        if (!cn || !w.districtSims.has(n.parent)) return;
        let lx = x - cn.x, ly = z - cn.y;
        const lim = Math.max(0, cn.r - n.r);
        const d = Math.sqrt(lx * lx + ly * ly);
        if (d > lim) { const k = d > 0 ? lim / d : 0; lx *= k; ly *= k; }
        n.fx = lx; n.fy = ly;
      }
      w.pins.add(n);
      syncAlphaTargets();
      publishHot(w);
    },

    release(ref: NodeRef) {
      const n = findNode(ref);
      if (!n || !w.pins.delete(n)) return;
      n.fx = null; n.fy = null;
      syncAlphaTargets();
      publishHot(w, reset ? 1 : 0);
    },

    resetLayout(): Promise<void> {
      endReset();
      clearPins();
      const { districts } = simLists(w);
      sleep(w.cityTier.sim);
      for (const ds of districts) sleep(ds.sim);
      const movers: Mover[] = [];
      const add = (n: PNode) => {
        n.vx = 0; n.vy = 0;
        if (n.hasHome && (n.x !== n.hx || n.y !== n.hy)) movers.push({ node: n, fromX: n.x, fromY: n.y });
      };
      for (const n of w.cityTier.nodes) add(n);
      for (const ds of districts) for (const n of ds.nodes) add(n);
      if (!movers.length) {
        publishHot(w);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          advanceReset(Infinity);
          flush(w);
          publishHot(w);
        }, t.resetMs + 250);
        reset = { start: now(), movers, resolve, timer };
        publishHot(w, 1);
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
        out.district.xzr.push(f(n.x), f(n.y), f(n.r));
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
      const units = w.replica.table('unit'), districtTable = w.replica.table('district'), cityTable = w.replica.table('city');
      const place = (n: PNode | undefined, x: number, y: number): n is PNode => {
        if (!n || !finite(x) || !finite(y)) return false;
        n.x = x; n.y = y; n.vx = 0; n.vy = 0; n.placed = true;
        return true;
      };
      const area = (n: PNode, r: number, home: number[], i: number) => {
        if (finite(r) && r > 0) { n.r = r; n.measured = true; }
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
      // Everything is left asleep, with containment sized to the loaded territories.
      const { districts, files } = simLists(w);
      for (const fs of files) {
        sleep(fs.sim);
        fs.contentDirty = false;
        const dn = w.districtNodes[fs.district];
        if (dn?.measured) fs.containR = Math.max(0, dn.r - t.file.pad);
      }
      for (const ds of districts) {
        sleep(ds.sim);
        ds.contentDirty = false;
        refreshRadii(ds);
        const cn = w.cityNodes[ds.city];
        if (cn?.measured) ds.containR = Math.max(0, cn.r - t.district.pad);
      }
      sleep(w.cityTier.sim);
      refreshRadii(w.cityTier);
      touchAll(w);
      flush(w);
      publishHot(w);
    },

    unitsOf(district: number) {
      return w.fileSims.get(district)?.nodes ?? [];
    },

    dispose() {
      endReset();
      w.pins.clear();
      w.bufferListeners.clear();
    },
  };
  return engine;
}
