// A PhysicsApi with no simulation: deterministic geometric placement (cities on a ring, districts on
// a ring inside their city, units on a phyllotaxis spiral inside their district). It lets the
// renderer, the app shell and the dev harness show a map before the real physics package exists.
import type { PhysicsApi, PhysicsEngine, PhysicsInit, PositionBuffers, SettleReport } from '../contracts/physics';
import { GEN_ANY, GEN_CITY, GEN_DISTRICT0, GEN_REV } from '../contracts/physics';
import { createReplica } from '../model';
import type { LayoutSnapshot, PatchBatch } from '../model/types';
import { unitRadius } from '../shared';

function allocate(cap: PhysicsInit['capacity']): PositionBuffers {
  const shared = typeof SharedArrayBuffer !== 'undefined' && (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated);
  const buf = (bytes: number) => (shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
  return {
    shared,
    unit: new Float32Array(buf(cap.units * 2 * 4)),
    district: new Float32Array(buf(cap.districts * 3 * 4)),
    city: new Float32Array(buf(cap.cities * 3 * 4)),
    gen: new Int32Array(buf((GEN_DISTRICT0 + cap.districts) * 4)),
  };
}

export function createStaticPhysics(init: PhysicsInit): PhysicsEngine {
  const replica = createReplica();
  let cap = { ...init.capacity };
  let positions = allocate(cap);
  const listeners = new Set<(b: PositionBuffers) => void>();
  let home: { district: Float32Array; city: Float32Array } | null = null;
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));

  function ensureCapacity(): void {
    const need = { units: replica.table('unit').capacity, districts: replica.table('district').capacity, cities: replica.table('city').capacity };
    if (need.units <= cap.units && need.districts <= cap.districts && need.cities <= cap.cities) return;
    cap = { units: Math.max(cap.units, need.units * 2), districts: Math.max(cap.districts, need.districts * 2), cities: Math.max(cap.cities, need.cities * 2) };
    positions = allocate(cap);
    for (const fn of listeners) fn(positions);
  }

  function layout(): void {
    ensureCapacity();
    const units = replica.table('unit'), districts = replica.table('district'), cities = replica.table('city');
    const { unit, district, city, gen } = positions;
    // units: spiral by descending radius inside each district
    const byDistrict = new Map<number, number[]>();
    for (const u of units.slots()) {
      const d = units.refSlots.district[u];
      let list = byDistrict.get(d);
      if (!list) byDistrict.set(d, (list = []));
      list.push(u);
    }
    const districtR = new Map<number, number>();
    for (const [d, list] of byDistrict) {
      const radius = (u: number) => unitRadius(units.cols.loc[u], units.cols.importancePct[u], init.config.visual);
      list.sort((a, b) => radius(b) - radius(a) || a - b);
      let area = 0;
      let maxR = 0;
      list.forEach((u, i) => {
        const r = radius(u);
        area += Math.PI * (r + init.config.physics.file.pad) ** 2 * 1.6;
        const dist = i === 0 ? 0 : Math.sqrt(area / Math.PI);
        unit[2 * u] = dist * Math.cos(i * GOLDEN);
        unit[2 * u + 1] = dist * Math.sin(i * GOLDEN);
        maxR = Math.max(maxR, dist + r);
      });
      districtR.set(d, maxR + init.config.physics.district.pad);
    }
    // districts: ring inside each city
    const byCity = new Map<number, number[]>();
    for (const d of districts.slots()) {
      const c = districts.refSlots.city[d];
      let list = byCity.get(c);
      if (!list) byCity.set(c, (list = []));
      list.push(d);
    }
    const cityR = new Map<number, number>();
    for (const [c, list] of byCity) {
      const radii = list.map((d) => districtR.get(d) ?? init.config.physics.district.pad);
      const circumference = radii.reduce((a, r) => a + 2 * r, 0);
      const ring = list.length === 1 ? 0 : Math.max(circumference / (2 * Math.PI), Math.max(...radii));
      let angle = 0;
      list.forEach((d, i) => {
        const half = list.length === 1 ? 0 : (radii[i] / circumference) * 2 * Math.PI;
        angle += half;
        district[3 * d] = ring * Math.cos(angle);
        district[3 * d + 1] = ring * Math.sin(angle);
        district[3 * d + 2] = radii[i];
        angle += half;
      });
      cityR.set(c, ring + Math.max(...radii));
    }
    // cities: ring in the world
    const cs = cities.slots();
    const radii = cs.map((c) => cityR.get(c) ?? 10);
    const gap = init.config.physics.city.gap;
    const circumference = radii.reduce((a, r) => a + 2 * r + gap, 0);
    const ring = cs.length <= 1 ? 0 : Math.max(circumference / (2 * Math.PI), Math.max(...radii));
    let angle = 0;
    cs.forEach((c, i) => {
      const half = cs.length <= 1 ? 0 : ((radii[i] + gap / 2) / circumference) * 2 * Math.PI;
      angle += half;
      city[3 * c] = ring * Math.cos(angle);
      city[3 * c + 1] = ring * Math.sin(angle);
      city[3 * c + 2] = radii[i];
      angle += half;
    });
    gen[GEN_REV] = replica.rev;
    gen[GEN_ANY]++;
    gen[GEN_CITY]++;
    for (const d of districts.slots()) gen[GEN_DISTRICT0 + d]++;
    if (!home) home = { district: district.slice(), city: city.slice() };
  }

  const api: PhysicsEngine = {
    get positions() { return positions; },
    onBuffers(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    applyBatch(batch: PatchBatch) {
      if (!replica.apply(batch)) throw new Error('static physics: revision gap');
      layout();
    },
    async settle(): Promise<SettleReport> {
      layout();
      home = { district: positions.district.slice(), city: positions.city.slice() };
      return { ms: 0, ticks: 0, atRest: true, overlapShare: 0 };
    },
    // nothing is simulated here, so there is nothing to animate: the new layout is simply in place
    relayout(maxMs: number): Promise<SettleReport> { return api.settle(maxMs); },
    drag(ref, x, z) {
      const kind = ref[0] === 'c' ? 'city' : ref[0] === 'd' ? 'district' : null;
      if (!kind) return;
      const slot = replica.table(kind).slotOf(ref.slice(2));
      if (slot < 0) return;
      if (kind === 'city') {
        positions.city[3 * slot] = x; positions.city[3 * slot + 1] = z;
        positions.gen[GEN_CITY]++;
      } else {
        const c = replica.table('district').refSlots.city[slot];
        positions.district[3 * slot] = x - positions.city[3 * c];
        positions.district[3 * slot + 1] = z - positions.city[3 * c + 1];
        positions.gen[GEN_DISTRICT0 + slot]++;
      }
      positions.gen[GEN_ANY]++;
    },
    release() {},
    async resetLayout() {
      if (!home) return;
      positions.district.set(home.district.subarray(0, positions.district.length));
      positions.city.set(home.city.subarray(0, positions.city.length));
      positions.gen[GEN_ANY]++;
      positions.gen[GEN_CITY]++;
      for (const d of replica.table('district').slots()) positions.gen[GEN_DISTRICT0 + d]++;
    },
    isAtHome() {
      if (!home) return true;
      for (let i = 0; i < home.city.length; i++) if (home.city[i] !== positions.city[i]) return false;
      for (let i = 0; i < home.district.length; i++) if (home.district[i] !== positions.district[i]) return false;
      return true;
    },
    setFocus() {},
    async getLayout(): Promise<LayoutSnapshot> {
      const units = replica.table('unit'), districts = replica.table('district'), cities = replica.table('city');
      const out: LayoutSnapshot = { unit: { ids: [], xz: [] }, district: { ids: [], xzr: [] }, city: { ids: [], xzr: [] }, home: { district: [], city: [] } };
      for (const u of units.slots()) { out.unit.ids.push(units.ids[u]!); out.unit.xz.push(positions.unit[2 * u], positions.unit[2 * u + 1]); }
      for (const d of districts.slots()) {
        out.district.ids.push(districts.ids[d]!);
        out.district.xzr.push(positions.district[3 * d], positions.district[3 * d + 1], positions.district[3 * d + 2]);
        out.home.district.push(home ? home.district[3 * d] : positions.district[3 * d], home ? home.district[3 * d + 1] : positions.district[3 * d + 1]);
      }
      for (const c of cities.slots()) {
        out.city.ids.push(cities.ids[c]!);
        out.city.xzr.push(positions.city[3 * c], positions.city[3 * c + 1], positions.city[3 * c + 2]);
        out.home.city.push(home ? home.city[3 * c] : positions.city[3 * c], home ? home.city[3 * c + 1] : positions.city[3 * c + 1]);
      }
      return out;
    },
    loadLayout(l: LayoutSnapshot) {
      const units = replica.table('unit'), districts = replica.table('district'), cities = replica.table('city');
      l.unit.ids.forEach((id, i) => { const s = units.slotOf(id); if (s >= 0) { positions.unit[2 * s] = l.unit.xz[2 * i]; positions.unit[2 * s + 1] = l.unit.xz[2 * i + 1]; } });
      l.district.ids.forEach((id, i) => { const s = districts.slotOf(id); if (s >= 0) positions.district.set(l.district.xzr.slice(3 * i, 3 * i + 3), 3 * s); });
      l.city.ids.forEach((id, i) => { const s = cities.slotOf(id); if (s >= 0) positions.city.set(l.city.xzr.slice(3 * i, 3 * i + 3), 3 * s); });
      home = { district: positions.district.slice(), city: positions.city.slice() };
      l.district.ids.forEach((id, i) => { const s = districts.slotOf(id); if (s >= 0) { home!.district[3 * s] = l.home.district[2 * i]; home!.district[3 * s + 1] = l.home.district[2 * i + 1]; } });
      l.city.ids.forEach((id, i) => { const s = cities.slotOf(id); if (s >= 0) { home!.city[3 * s] = l.home.city[2 * i]; home!.city[3 * s + 1] = l.home.city[2 * i + 1]; } });
      positions.gen[GEN_ANY]++;
      positions.gen[GEN_CITY]++;
      for (const d of districts.slots()) positions.gen[GEN_DISTRICT0 + d]++;
    },
    step() { return 0; },
    dispose() { listeners.clear(); },
  };
  return api;
}

export type { PhysicsApi };
