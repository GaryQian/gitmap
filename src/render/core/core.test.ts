import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import { GEN_ANY, GEN_CITY, GEN_DISTRICT0, GEN_REV } from '../../contracts/physics';
import { createReplica } from '../../model';
import { cityRef, districtRef, fileRef, unitRef } from '../../model/types';
import { unitRadius } from '../../shared';
import { createStaticPhysics } from '../../testing/staticPhysics';
import { syntheticBatch } from '../../testing/synthetic';
import { anchorOf, mapBounds } from './anchor';
import { CameraRig } from './camera';
import { copyXzr, diffGenerations, newGenSeen, slotTexHeight, SLOT_TEX_WIDTH } from './positions';
import { touchedUnits } from './unitRow';

function world(files = 200) {
  const replica = createReplica();
  const batch = syntheticBatch({ files, seed: 5 });
  replica.apply(batch);
  const physics = createStaticPhysics({ config, capacity: { units: files + 8, districts: 256, cities: 32 } });
  physics.applyBatch(batch);
  return { replica, physics, batch };
}

describe('position generations', () => {
  it('reports which tiers changed, once', () => {
    const gen = new Int32Array(GEN_DISTRICT0 + 4);
    const seen = newGenSeen();
    expect(diffGenerations(gen, seen)).toMatchObject({ any: true, city: true, district: true });
    expect(diffGenerations(gen, seen)).toMatchObject({ any: false, city: false, district: false, rev: false });
    gen[GEN_ANY]++; gen[GEN_CITY]++;
    expect(diffGenerations(gen, seen)).toMatchObject({ any: true, city: true, district: false });
    gen[GEN_ANY]++; gen[GEN_DISTRICT0 + 2]++;
    expect(diffGenerations(gen, seen)).toMatchObject({ any: true, city: false, district: true });
    gen[GEN_REV] = 7;
    expect(diffGenerations(gen, seen)).toMatchObject({ any: false, rev: true });
    // a write that bumps only GEN_ANY is treated as "everything may have changed"
    gen[GEN_ANY]++;
    expect(diffGenerations(gen, seen)).toMatchObject({ city: true, district: true });
  });

  it('pads [x, z, r] rows to texels and sizes textures by slot count', () => {
    const dst = new Float32Array(12);
    copyXzr(new Float32Array([1, 2, 3, 4, 5, 6]), dst);
    expect(Array.from(dst.subarray(0, 8))).toEqual([1, 2, 3, 0, 4, 5, 6, 0]);
    expect(slotTexHeight(0)).toBe(1);
    expect(slotTexHeight(SLOT_TEX_WIDTH)).toBe(1);
    expect(slotTexHeight(SLOT_TEX_WIDTH + 1)).toBe(2);
  });
});

describe('anchors', () => {
  it('composes city + district + unit, with a unit centre at y = radius', () => {
    const { replica, physics } = world();
    const pos = physics.positions;
    const units = replica.table('unit'), districts = replica.table('district'), cities = replica.table('city');
    const u = units.slots()[17], d = units.refSlots.district[u], c = districts.refSlots.city[d];
    const a = anchorOf(unitRef(units.ids[u]!), replica, pos, config.visual)!;
    expect(a.x).toBeCloseTo(pos.city[3 * c] + pos.district[3 * d] + pos.unit[2 * u], 3);
    expect(a.z).toBeCloseTo(pos.city[3 * c + 1] + pos.district[3 * d + 1] + pos.unit[2 * u + 1], 3);
    expect(a.y).toBeCloseTo(unitRadius(units.cols.loc[u], units.cols.importancePct[u], config.visual), 6);
    expect(anchorOf(fileRef(units.cols.primaryFile[u]), replica, pos, config.visual)).toEqual(a);
    const da = anchorOf(districtRef(districts.ids[d]!), replica, pos, config.visual)!;
    expect(da.y).toBe(0);
    expect(da.x).toBeCloseTo(pos.city[3 * c] + pos.district[3 * d], 3);
    expect(anchorOf(cityRef(cities.ids[c]!), replica, pos, config.visual)!.r).toBeCloseTo(pos.city[3 * c + 2], 3);
    expect(anchorOf(unitRef('no/such/file'), replica, pos, config.visual)).toBeNull();
  });

  it('bounds every city', () => {
    const { replica, physics } = world();
    const b = mapBounds(replica, physics.positions)!;
    const pos = physics.positions.city;
    for (const c of replica.table('city').slots()) {
      expect(Math.hypot(pos[3 * c] - b.x, pos[3 * c + 1] - b.z) + pos[3 * c + 2]).toBeLessThanOrEqual(b.r + 1e-3);
    }
    expect(mapBounds(createReplica(), physics.positions)).toBeNull();
  });
});

describe('batch → touched units', () => {
  it('collects unit slots and flags district changes', () => {
    const t = touchedUnits({ rev: 2, baseRev: 1, ops: [
      { op: 'add', kind: 'unit', rows: { ids: ['a'], slots: [4], cols: {} } },
      { op: 'remove', kind: 'unit', rows: { ids: ['b'], slots: [9], cols: {} } },
      { op: 'assign', unitIds: ['c'], districtIds: ['d'], units: [2], districts: [0] },
      { op: 'add', kind: 'edge', rows: { ids: ['e'], slots: [0], cols: {} } },
    ] });
    expect(t.slots.sort((a, b) => a - b)).toEqual([2, 4, 9]);
    expect(t.all).toBe(false);
    expect(touchedUnits({ rev: 2, baseRev: 1, ops: [{ op: 'update', kind: 'district', rows: { ids: ['d'], slots: [0], cols: {} } }] }).all).toBe(true);
  });
});

describe('camera', () => {
  function rig() {
    const r = new CameraRig(config.camera);
    r.bounds = { x: 40, z: -25, r: 600 };
    r.topHeight = 30;
    r.setViewport(1200, 700);
    r.snapTo(r.defaultView());
    return r;
  }

  it('frames the whole map in the default view', () => {
    const r = rig();
    expect(r.isDefaultView()).toBe(true);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const p = r.project(r.bounds.x + Math.cos(a) * r.bounds.r, 0, r.bounds.z + Math.sin(a) * r.bounds.r);
      expect(p.visible).toBe(true);
    }
  });

  it('round-trips a ground point through projection and picking', () => {
    const r = rig();
    const p = r.project(120, 0, 80);
    const g = r.groundAt(p.x, p.y)!;
    expect(g.x).toBeCloseTo(120, 2);
    expect(g.z).toBeCloseTo(80, 2);
    expect(r.groundAt(600, -1e6)).toBeNull(); // far above the horizon
  });

  it('keeps the grabbed ground point under the cursor while panning, and under the pointer while zooming', () => {
    const r = rig();
    const grabbed = r.groundAt(500, 400)!;
    r.panStart(500, 400);
    r.panMove(640, 330);
    r.dragEnd();
    const after = r.groundAt(640, 330)!;
    expect(after.x).toBeCloseTo(grabbed.x, 2);
    expect(after.z).toBeCloseTo(grabbed.z, 2);
    expect(r.isDefaultView()).toBe(false);

    const before = r.groundAt(300, 500)!;
    const d0 = r.view.distance;
    r.zoomAt(300, 500, 0.7, 0);
    expect(r.view.distance).toBeLessThan(d0);
    const zoomed = r.groundAt(300, 500)!;
    expect(zoomed.x).toBeCloseTo(before.x, 2);
    expect(zoomed.z).toBeCloseTo(before.z, 2);
  });

  it('pinches: zooms about the point between the fingers and pans as they move together', () => {
    const r = rig();
    const grabbed = r.groundAt(500, 400)!;
    const d0 = r.view.distance;
    r.pinchStart(500, 400);
    expect(r.isMoving(0)).toBe(true);
    r.pinchMove(500, 400, 0.5);          // fingers spread to twice the distance: twice as close
    expect(r.view.distance).toBeCloseTo(d0 / 2, 6);
    let now = r.groundAt(500, 400)!;
    expect(now.x).toBeCloseTo(grabbed.x, 2);
    expect(now.z).toBeCloseTo(grabbed.z, 2);
    r.pinchMove(620, 340, 1);            // both fingers move: the grabbed point follows them
    expect(r.view.distance).toBeCloseTo(d0 / 2, 6);
    now = r.groundAt(620, 340)!;
    expect(now.x).toBeCloseTo(grabbed.x, 2);
    expect(now.z).toBeCloseTo(grabbed.z, 2);
    r.pinchMove(620, 340, 1e-9);         // clamped like the wheel
    expect(r.view.distance).toBe(config.camera.minDistance);
    r.dragEnd();
    expect(r.isMoving(1e9)).toBe(false);
    const view = { ...r.view };
    r.pinchMove(100, 100, 2);            // nothing after the fingers lift
    expect(r.view).toEqual(view);
  });

  it('turns with a two-finger twist and tilts with a two-finger slide, about the point between the fingers', () => {
    const r = rig();
    const pivot = r.groundAt(500, 400)!;
    const beside = r.groundAt(700, 400)!;          // a ground point to the right of the fingers
    r.pinchStart(500, 400);
    const az0 = r.view.azimuth;
    r.pinchMove(500, 400, 1, 0.3);                 // the fingers twist clockwise
    expect(Math.abs(r.view.azimuth - az0)).toBeCloseTo(0.3, 9);
    let now = r.groundAt(500, 400)!;
    expect(now.x).toBeCloseTo(pivot.x, 1);
    expect(now.z).toBeCloseTo(pivot.z, 1);
    // the map turned the way the fingers did: what was to the right is now lower on the screen
    expect(r.project(beside.x, 0, beside.z).y).toBeGreaterThan(400 + 20);

    const el0 = r.view.elevation;
    r.pinchTilt(60);                               // both fingers slide down: toward top-down
    expect(r.view.elevation).toBeGreaterThan(el0);
    r.pinchTilt(-1e6);                             // and up: toward the horizon, clamped
    expect(r.view.elevation).toBeGreaterThan(0);
    expect(r.view.elevation).toBeLessThan(el0);
    now = r.groundAt(500, 400)!;
    expect(now.x).toBeCloseTo(pivot.x, 1);
    expect(now.z).toBeCloseTo(pivot.z, 1);
    r.dragEnd();
    const view = { ...r.view };
    r.pinchTilt(40);                               // nothing after the fingers lift
    expect(r.view).toEqual(view);
  });

  it('orbits around the ground point under the pointer and respects the distance clamps', () => {
    const r = rig();
    const pivot = r.groundAt(700, 450)!;
    r.orbitStart(700, 450);
    r.orbitMove(80, -30);
    r.dragEnd();
    const after = r.groundAt(700, 450)!;
    expect(after.x).toBeCloseTo(pivot.x, 1);
    expect(after.z).toBeCloseTo(pivot.z, 1);
    r.zoomAt(600, 350, 1e-9, 0);
    expect(r.view.distance).toBe(config.camera.minDistance);
    r.zoomAt(600, 350, 1e12, 0);
    expect(r.view.distance).toBe(config.camera.maxDistance);
  });

  it('flies to a view and resolves when it arrives', async () => {
    const r = rig();
    let done = false;
    const flight = r.flyTo({ x: 100, z: 100, distance: 200 }, 100, 1000).then(() => { done = true; });
    r.update(1050);
    expect(done).toBe(false);
    expect(r.isMoving(1050)).toBe(true);
    r.update(1100);
    await flight;
    expect(done).toBe(true);
    expect(r.view.x).toBeCloseTo(100, 6);
    expect(r.view.distance).toBeCloseTo(200, 6);
    expect(r.isMoving(2000)).toBe(false);
  });
});
