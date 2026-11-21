// Physics engine, in process, on synthetic models. Light on purpose (IMPLEMENTATION.md §3): facts that
// would silently corrupt the map, never tunable values or timings. Overlap and settle time are printed.
import { describe, expect, it } from 'vitest';
import { config } from '../config';
import { GEN_HOT, GEN_REV, type PhysicsEngine } from '../contracts/physics';
import { createReplica } from '../model';
import type { PatchBatch } from '../model/types';
import { syntheticBatch } from '../testing/synthetic';
import { createPhysicsEngine } from './index';

const CAP_MS = 60_000; // generous: determinism holds only while the cap is not reached
const FILES = 600;

function build(batch: PatchBatch, capacity = { units: 1024, districts: 128, cities: 32 }): PhysicsEngine {
  const engine = createPhysicsEngine({ config, capacity });
  engine.applyBatch(batch);
  return engine;
}

/** The model the engine was given, for looking up parents and slots. */
function modelOf(batch: PatchBatch) {
  const replica = createReplica();
  replica.apply(batch);
  return { units: replica.table('unit'), districts: replica.table('district'), cities: replica.table('city') };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('physics engine', () => {
  const batch = syntheticBatch({ files: FILES });
  const model = modelOf(batch);

  it('settles to rest with cities apart, districts inside cities and units inside districts', async () => {
    const engine = build(batch);
    const report = await engine.settle(CAP_MS);
    expect(report.atRest).toBe(true);
    expect(report.ticks).toBeGreaterThan(0);
    const { unit, district, city, gen } = engine.positions;
    expect(gen[GEN_HOT]).toBe(0);
    expect(gen[GEN_REV]).toBe(batch.rev);
    expect(engine.step(config.physics.sliceMs)).toBe(0);

    const cs = model.cities.slots();
    expect(cs.length).toBeGreaterThan(1);
    for (const a of cs) {
      for (const b of cs) {
        if (b <= a) continue;
        const dist = Math.hypot(city[3 * a] - city[3 * b], city[3 * a + 1] - city[3 * b + 1]);
        expect(dist).toBeGreaterThanOrEqual((city[3 * a + 2] + city[3 * b + 2]) * 0.99);
      }
    }
    for (const d of model.districts.slots()) {
      const c = model.districts.refSlots.city[d];
      const reach = Math.hypot(district[3 * d], district[3 * d + 1]) + district[3 * d + 2];
      expect(district[3 * d + 2]).toBeGreaterThan(0);
      expect(reach).toBeLessThanOrEqual(city[3 * c + 2] * 1.01);
    }
    for (const u of model.units.slots()) {
      const d = model.units.refSlots.district[u];
      const x = unit[2 * u], z = unit[2 * u + 1];
      expect(Number.isFinite(x) && Number.isFinite(z)).toBe(true);
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(district[3 * d + 2] * 1.01);
    }
    engine.dispose();
  });

  it('gives the same layout for the same input', async () => {
    const a = build(batch), b = build(batch);
    await a.settle(CAP_MS);
    await b.settle(CAP_MS);
    expect(Array.from(a.positions.unit)).toEqual(Array.from(b.positions.unit));
    expect(Array.from(a.positions.district)).toEqual(Array.from(b.positions.district));
    expect(Array.from(a.positions.city)).toEqual(Array.from(b.positions.city));
    a.dispose();
    b.dispose();
  });

  it('restores a saved layout into a fresh engine, asleep and at home', async () => {
    const a = build(batch);
    await a.settle(CAP_MS);
    const layout = JSON.parse(JSON.stringify(await a.getLayout()));
    const b = build(batch);
    b.loadLayout(layout);
    expect(Array.from(b.positions.unit)).toEqual(Array.from(a.positions.unit));
    expect(Array.from(b.positions.district)).toEqual(Array.from(a.positions.district));
    expect(Array.from(b.positions.city)).toEqual(Array.from(a.positions.city));
    expect(b.step(config.physics.sliceMs)).toBe(0);
    expect(b.isAtHome()).toBe(true);
    a.dispose();
    b.dispose();
  });

  it('returns cities and districts to home after a drag, a release and a reset', async () => {
    const engine = build(batch);
    await engine.settle(CAP_MS);
    const homeCity = Array.from(engine.positions.city);
    const homeDistrict = Array.from(engine.positions.district);
    const homeUnit = Array.from(engine.positions.unit);
    expect(engine.isAtHome()).toBe(true);

    const c = model.cities.slots()[0];
    const ref = `c:${model.cities.ids[c]!}` as const;
    const x = homeCity[3 * c] + 400, z = homeCity[3 * c + 1] - 250;
    engine.drag(ref, x, z);
    for (let i = 0; i < 30; i++) expect(engine.step(config.physics.sliceMs)).toBe(1); // only the city sim is hot
    expect(engine.positions.city[3 * c]).toBeCloseTo(x, 3);
    expect(engine.positions.city[3 * c + 1]).toBeCloseTo(z, 3);
    expect(engine.isAtHome()).toBe(false);
    engine.release(ref);
    for (let i = 0; i < 10; i++) engine.step(config.physics.sliceMs);

    // a district drag is clamped to its city
    const d = model.districts.slots()[0];
    const dc = model.districts.refSlots.city[d];
    const dref = `d:${model.districts.ids[d]!}` as const;
    engine.drag(dref, 1e6, 1e6);
    for (let i = 0; i < 5; i++) engine.step(config.physics.sliceMs);
    const { district, city } = engine.positions;
    expect(Math.hypot(district[3 * d], district[3 * d + 1]) + district[3 * d + 2]).toBeLessThanOrEqual(city[3 * dc + 2] * 1.01);
    engine.release(dref);

    const done = engine.resetLayout();
    while (engine.step(config.physics.sliceMs) > 0) await sleep(20);
    await done;
    expect(engine.isAtHome()).toBe(true);
    expect(Array.from(engine.positions.city)).toEqual(homeCity);
    expect(Array.from(engine.positions.district)).toEqual(homeDistrict);
    expect(Array.from(engine.positions.unit)).toEqual(homeUnit); // units never moved: they ride on their district
    engine.dispose();
  });

  it('applies incremental batches, grows its buffers and refuses a revision gap', async () => {
    const engine = build(batch, { units: FILES, districts: model.districts.capacity, cities: model.cities.capacity });
    await engine.settle(CAP_MS);
    let grown = 0;
    engine.onBuffers(() => { grown++; });

    const before = engine.positions;
    const d0 = model.districts.slots()[0];
    const districtId = model.districts.ids[d0]!;
    const neighbour = model.units.slots().find((u) => model.units.refSlots.district[u] === d0)!;
    const removed = model.units.slots().find((u) => model.units.refSlots.district[u] === d0 && u !== neighbour);
    const ids = ['new/a.ts', 'new/b.ts', 'new/c.ts'];
    const slots = ids.map((_, i) => FILES + i);
    const next: PatchBatch = {
      rev: batch.rev + 1, baseRev: batch.rev, ops: [
        { op: 'add', kind: 'unit', rows: { ids, slots, cols: { loc: [900, 40, 5000], importancePct: [0.2, 0.9, 0.5], district: ids.map(() => districtId) } } },
        { op: 'add', kind: 'edge', rows: { ids: ['e-new'], slots: [model.units.capacity * 8], cols: { src: [ids[0]], dst: [model.units.ids[neighbour]!], weight: [2] } } },
        ...(removed === undefined ? [] : [{ op: 'remove' as const, kind: 'unit' as const, rows: { ids: [model.units.ids[removed]!], slots: [removed], cols: {} } }]),
      ],
    };
    expect(() => engine.applyBatch({ ...next, baseRev: batch.rev + 5, rev: batch.rev + 6 })).toThrow(/revision gap/);
    engine.applyBatch(next);
    expect(grown).toBe(1);
    expect(engine.positions).not.toBe(before);
    expect(engine.positions.unit.length).toBeGreaterThanOrEqual((FILES + ids.length) * 2);
    expect(engine.positions.gen[GEN_REV]).toBe(next.rev);
    // old rows survived the reallocation
    expect(Array.from(engine.positions.city)).toEqual(Array.from(before.city));
    // the new units were placed inside the district at once, not on d3's default spiral
    for (const s of slots) {
      const x = engine.positions.unit[2 * s], z = engine.positions.unit[2 * s + 1];
      expect(Number.isFinite(x) && Number.isFinite(z)).toBe(true);
      expect(Math.hypot(x, z)).toBeLessThan(engine.positions.district[3 * d0 + 2] * 2);
    }
    // the affected simulations were reheated and come back to rest on their own
    expect(engine.positions.gen[GEN_HOT]).toBeGreaterThan(0);
    let guard = 0;
    while (engine.step(1000) > 0) expect(++guard).toBeLessThan(5000);
    for (const v of engine.positions.unit) expect(Number.isFinite(v)).toBe(true);
    for (const v of engine.positions.district) expect(Number.isFinite(v)).toBe(true);
    for (const v of engine.positions.city) expect(Number.isFinite(v)).toBe(true);
    for (const s of slots) {
      expect(Math.hypot(engine.positions.unit[2 * s], engine.positions.unit[2 * s + 1])).toBeLessThanOrEqual(engine.positions.district[3 * d0 + 2] * 1.01);
    }
    engine.dispose();
  });

  it('reports settle time and overlap at 2,000 and 10,000 files (printed, not asserted)', async () => {
    for (const files of [2000, 10000]) {
      const big = syntheticBatch({ files });
      const t0 = performance.now();
      const engine = build(big, { units: files, districts: 256, cities: 32 });
      const buildMs = performance.now() - t0;
      const report = await engine.settle(CAP_MS);
      console.log(
        `[physics] ${files} files: build ${buildMs.toFixed(0)} ms, settle ${report.ms.toFixed(0)} ms, ${report.ticks} ticks, ` +
        `atRest ${report.atRest}, overlapShare ${(report.overlapShare * 100).toFixed(1)}% (sizeVsConnectivity ${config.physics.file.sizeVsConnectivity})`,
      );
      expect(Number.isFinite(report.overlapShare)).toBe(true);
      engine.dispose();
    }
  });
});
