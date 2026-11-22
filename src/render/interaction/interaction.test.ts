import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import { GEN_ANY, GEN_DISTRICT0, type PositionBuffers } from '../../contracts/physics';
import { createReplica } from '../../model';
import { createStaticPhysics } from '../../testing/staticPhysics';
import { syntheticBatch } from '../../testing/synthetic';
import { mapBounds } from '../core/anchor';
import { CameraRig } from '../core/camera';
import { unitReader } from '../core/unitRow';
import { JiggleField, NeighbourHash } from './jiggle';
import { rectFrom, unitsInRect } from './marquee';
import { buildPickIndex, forEachUnit, pickUnit, raySphere, rayThroughPixel, type PickIndex, type Ray } from './picking';
import { INTERACTION_LOCAL } from './tunables';

const W = 1280, H = 800;

/** A synthetic model with static positions, the lookup rows the renderer keeps, and a camera on the default view. */
function world(files = 600) {
  const replica = createReplica();
  const batch = syntheticBatch({ files, seed: 7 });
  replica.apply(batch);
  const physics = createStaticPhysics({ config, capacity: { units: files + 8, districts: 256, cities: 32 } });
  physics.applyBatch(batch);
  const capacity = replica.table('unit').capacity;
  const read = unitReader(replica, config.visual);
  const info = new Float32Array(capacity * 4);
  for (let s = 0; s < capacity; s++) {
    const row = read(s);
    if (row) info.set([row.radius, row.district, row.city, row.glow], 4 * s);
  }
  const rig = new CameraRig(config.camera);
  rig.setViewport(W, H);
  rig.bounds = mapBounds(replica, physics.positions)!;
  rig.snapTo(rig.defaultView());
  return { replica, pos: physics.positions, index: buildPickIndex(info, capacity), rig };
}

/** One city, one district, spheres at the given local [x, z, radius]. */
function scene(units: [number, number, number][]): { index: PickIndex; pos: PositionBuffers } {
  const info = new Float32Array(units.length * 4);
  const pos: PositionBuffers = {
    shared: false, unit: new Float32Array(units.length * 2), district: new Float32Array([10, -5, 50]), city: new Float32Array([100, 40, 80]),
    gen: new Int32Array(GEN_DISTRICT0 + 1),
  };
  units.forEach(([x, z, r], s) => { info.set([r, 0, 0, 0], 4 * s); pos.unit.set([x, z], 2 * s); });
  return { index: buildPickIndex(info, units.length), pos };
}

function rayToward(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number): Ray {
  const dx = tx - ox, dy = ty - oy, dz = tz - oz, len = Math.hypot(dx, dy, dz);
  return { ox, oy, oz, dx: dx / len, dy: dy / len, dz: dz / len };
}

function pickBrute(ray: Ray, index: PickIndex, pos: PositionBuffers): number {
  let best = Infinity, slot = -1;
  forEachUnit(index, pos, (s, x, y, z) => {
    const t = raySphere(ray, x, y, z, index.radius[s]);
    if (t >= 0 && t < best) { best = t; slot = s; }
  });
  return slot;
}

describe('picking', () => {
  it('returns the nearest sphere along the ray and ignores hidden ones', () => {
    // world centres: (110 + x, r, 35 + z); the ray runs along +x, low over the ground, through all three
    const { index, pos } = scene([[0, 0, 3], [12, 0, 3], [24, 0, 3]]);
    const ray = rayToward(60, 3, 35, 200, 3, 35);
    expect(pickUnit(ray, index, pos)?.slot).toBe(0);
    expect(pickUnit(ray, index, pos, { isShown: (s) => s !== 0 })?.slot).toBe(1);
    expect(pickUnit(ray, index, pos, { isShown: (s) => s === 2 })?.slot).toBe(2);
    expect(pickUnit(ray, index, pos, { isShown: () => false })).toBeNull();
    // from above, straight down beside a sphere: a miss, unless the pixel tolerance reaches it
    const beside = rayToward(110 + 12 + 3.5, 200, 35, 110 + 12 + 3.5, 0, 35);
    expect(pickUnit(beside, index, pos)).toBeNull();
    expect(pickUnit(beside, index, pos, { minRadiusPerDistance: 4 / 200 })?.slot).toBe(1);
  });

  it('uses rest positions as they are now: a moved sphere is picked where it moved to', () => {
    const { index, pos } = scene([[0, 0, 2], [30, 0, 2]]);
    const down = (x: number, z: number) => rayToward(x, 300, z, x, 0, z);
    expect(pickUnit(down(140, 35), index, pos)?.slot).toBe(1);
    pos.unit[2] = -40; // far outside the district's old bound
    pos.gen[GEN_ANY]++; pos.gen[GEN_DISTRICT0]++;
    expect(pickUnit(down(140, 35), index, pos)).toBeNull();
    expect(pickUnit(down(70, 35), index, pos)?.slot).toBe(1);
  });

  it('agrees with testing every sphere, across the view', () => {
    const { index, pos, rig } = world();
    const scratch = new THREE.Vector3();
    let hits = 0;
    for (let y = 20; y < H; y += 37) {
      for (let x = 15; x < W; x += 41) {
        const ray = rayThroughPixel(rig.camera, W, H, x, y, scratch);
        const expected = pickBrute(ray, index, pos);
        expect(pickUnit(ray, index, pos)?.slot ?? -1).toBe(expected);
        if (expected >= 0) hits++;
      }
    }
    expect(hits).toBeGreaterThan(5);
  });
});

describe('marquee', () => {
  it('selects the shown units whose projected centres are inside the rectangle', () => {
    const { index, pos, rig } = world();
    const rect = rectFrom(W * 0.62, H * 0.6, W * 0.3, H * 0.3); // corners in any order
    const expected: number[] = [];
    forEachUnit(index, pos, (s, x, y, z) => {
      const p = rig.project(x, y, z);
      if (p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1) expected.push(s);
    });
    const m = new THREE.Matrix4().multiplyMatrices(rig.camera.projectionMatrix, rig.camera.matrixWorldInverse).elements;
    const got = unitsInRect(rect, m, W, H, index, pos);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(index.unitList.length);
    expect([...got].sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
    const even = unitsInRect(rect, m, W, H, index, pos, (s) => s % 2 === 0);
    expect(even).toEqual(got.filter((s) => s % 2 === 0));
  });
});

describe('camera gestures', () => {
  const under = (rig: CameraRig, x: number, y: number) => rig.groundAt(x, y)!;
  const onScreen = (rig: CameraRig, g: { x: number; z: number }) => rig.project(g.x, 0, g.z);

  it('orbits around the ground point under the pointer: the pivot stays fixed on screen', () => {
    const { rig } = world();
    const px = 420, py = 520;
    const pivot = under(rig, px, py);
    const azimuth = rig.view.azimuth, elevation = rig.view.elevation;
    rig.orbitStart(px, py);
    for (const [dx, dy] of [[40, 0], [25, 12], [-10, 30], [60, -8]]) {
      rig.orbitMove(dx, dy);
      const p = onScreen(rig, pivot);
      expect(Math.hypot(p.x - px, p.y - py)).toBeLessThan(0.5);
    }
    rig.dragEnd();
    expect(rig.view.azimuth).not.toBeCloseTo(azimuth, 3);
    expect(rig.view.elevation).not.toBeCloseTo(elevation, 3);
  });

  it('pans with the grabbed ground point under the cursor, and zooms toward the cursor', () => {
    const { rig } = world();
    const grabbed = under(rig, 500, 450);
    rig.panStart(500, 450);
    rig.panMove(590, 400);
    rig.dragEnd();
    let p = onScreen(rig, grabbed);
    expect(Math.hypot(p.x - 590, p.y - 400)).toBeLessThan(0.5);

    const anchor = under(rig, 700, 500);
    const before = rig.view.distance;
    rig.zoomAt(700, 500, 0.6, 0);
    p = onScreen(rig, anchor);
    expect(rig.view.distance).toBeLessThan(before);
    expect(Math.hypot(p.x - 700, p.y - 500)).toBeLessThan(0.5);
  });
});

describe('jiggle', () => {
  const J = INTERACTION_LOCAL.jiggle;
  const make = () => new JiggleField({
    settleMs: config.interaction.jiggleSettleMs, maxRadii: config.interaction.jiggleMax,
    damping: J.damping, restFraction: J.restFraction, maxActive: J.maxActive,
  });

  it('never exceeds the clamp and settles within the configured time', () => {
    for (const dt of [1 / 120, 1 / 60, 1 / 20, 0.1]) {
      const field = make();
      const r = 5, limit = config.interaction.jiggleMax * r;
      let peak = 0;
      const last = { x: NaN, z: NaN };
      const out = (_slot: number, x: number, z: number) => { peak = Math.max(peak, Math.hypot(x, z)); last.x = x; last.z = z; };
      // hammered with far more than the strongest kick, from changing directions, every frame
      for (let i = 0; i < 40; i++) {
        field.kick(3, r, 1e6 * Math.cos(i), 1e6 * Math.sin(i * 1.7), true);
        field.step(dt, out);
      }
      expect(field.size).toBe(1);
      expect(peak).toBeGreaterThan(limit * 0.2);
      expect(peak).toBeLessThanOrEqual(limit * (1 + 1e-9));
      // left alone, it is at rest (and forgotten) within jiggleSettleMs
      for (let t = 0; t < config.interaction.jiggleSettleMs / 1000; t += dt) field.step(dt, out);
      expect(field.size).toBe(0);
      expect(last).toEqual({ x: 0, z: 0 });
    }
  });

  it('integrates nothing when no sphere is active, and ignores a kick too faint to see', () => {
    const field = make();
    let calls = 0;
    field.step(1 / 60, () => { calls++; });
    expect(field.kick(1, 4, 1e-9, 0)).toBe(false);
    field.step(1 / 60, () => { calls++; });
    expect(calls).toBe(0);
    expect(field.size).toBe(0);
  });

  it('finds neighbours through the spatial hash', () => {
    const { index, pos } = world();
    const d = index.districtList[0];
    const from = index.districtStart[d], to = index.districtStart[d + 1];
    let spread = 0;
    for (let i = from; i < to; i++) spread = Math.max(spread, Math.hypot(pos.unit[2 * index.unitList[i]], pos.unit[2 * index.unitList[i] + 1]));
    // around a point off the district's centre, reaching about half of it
    const x = spread * 0.2, z = -spread * 0.1, radius = spread * 0.6;
    const hash = new NeighbourHash(index.unitList, from, to, pos.unit, radius / 2.5);
    const got: number[] = [];
    hash.near(x, z, radius, (n) => got.push(n));
    const expected: number[] = [];
    for (let i = from; i < to; i++) {
      const n = index.unitList[i];
      if (Math.hypot(pos.unit[2 * n] - x, pos.unit[2 * n + 1] - z) <= radius) expected.push(n);
    }
    expect(expected.length).toBeGreaterThan(1);
    expect(expected.length).toBeLessThan(to - from);
    expect(got.sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
  });
});
