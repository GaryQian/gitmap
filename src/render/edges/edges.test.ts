// Light tests of the pure parts of the edge levels: aggregation, level of detail, budget order.
import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import { createReplica } from '../../model';
import { syntheticBatch } from '../../testing/synthetic';
import { aggregateRibbons, allocateBudget, forwardShare, rollUpRibbons, strongestFirst } from './aggregate';
import { inView, lodMix, lodThresholds, viewCircle } from './lod';
import { buildEdgeModel, edgesOfDistrict, edgesOfUnit } from './model';

describe('ribbon aggregation', () => {
  // units 0,1 in district 0; 2,3 in district 1; 4 in district 2; districts 0,1 in city 0; 2 in city 1
  const unitDistrict = [0, 0, 1, 1, 2];
  const districtCity = [0, 0, 1];
  const edges = {
    count: 6,
    src: [0, 1, 2, 3, 0, 0],
    dst: [2, 3, 0, 4, 1, 4],
    weight: [2, 1, 3, 4, 9, 0],
  };

  it('sums weights per district pair and keeps each direction’s share', () => {
    const ribbons = aggregateRibbons(edges, unitDistrict);
    const between = (a: number, b: number) => ribbons.find((r) => r.a === a && r.b === b)!;
    expect(ribbons).toHaveLength(2); // the edge inside district 0 and the zero-weight edge are left out
    const r01 = between(0, 1);
    expect(r01.weight).toBe(6);
    expect(r01.forward).toBe(3); // 0→2 and 1→3 run district 0 → 1; 2→0 runs back
    expect(forwardShare(r01)).toBeCloseTo(0.5);
    expect(r01.count).toBe(3);
    const r12 = between(1, 2);
    expect(r12.weight).toBe(4);
    expect(forwardShare(r12)).toBe(1);
  });

  it('rolls district ribbons up into city ribbons without losing traffic', () => {
    const cities = rollUpRibbons(aggregateRibbons(edges, unitDistrict), districtCity);
    expect(cities).toHaveLength(1); // districts 0 and 1 share a city
    expect(cities[0]).toMatchObject({ a: 0, b: 1, weight: 4, forward: 4, count: 1 });
  });

  it('matches a direct aggregation on a synthetic model', () => {
    const replica = createReplica();
    replica.apply(syntheticBatch({ files: 400, seed: 3 }));
    const model = buildEdgeModel(replica, config.visual, 0, []);
    const unitCity = Array.from(model.unitDistrict, (d) => (d < 0 ? -1 : model.districtCity[d]));
    const direct = aggregateRibbons({ count: model.capacity, src: model.src, dst: model.dst, weight: model.rank }, unitCity);
    const total = (list: { weight: number }[]) => list.reduce((s, r) => s + r.weight, 0);
    expect(model.cityRibbons.length).toBe(direct.length);
    expect(total(model.cityRibbons)).toBeCloseTo(total(direct), 3);
    // strongest first
    for (let i = 1; i < model.districtRibbons.length; i++) expect(model.districtRibbons[i - 1].weight).toBeGreaterThanOrEqual(model.districtRibbons[i].weight);
    // every drawable edge is listed under both of its units, and a district's list is strongest first
    const e = model.eff.findIndex((w) => w > 0);
    expect(Array.from(edgesOfUnit(model, model.src[e]))).toContain(e);
    expect(Array.from(edgesOfUnit(model, model.dst[e]))).toContain(e);
    const list = edgesOfDistrict(model, model.unitDistrict[model.src[e]]);
    for (let i = 1; i < list.length; i++) expect(model.rank[list[i - 1]]).toBeGreaterThanOrEqual(model.rank[list[i]]);
  });
});

describe('level of detail by camera distance', () => {
  const scale = { city: 200, district: 40 };
  const th = lodThresholds(scale);

  it('goes from city ribbons to district ribbons to file edges as the camera comes closer', () => {
    expect(th.near).toBeLessThan(th.far);
    const far = lodMix(th.far * 10, scale), mid = lodMix(Math.sqrt(th.far * th.near), scale), near = lodMix(th.near / 10, scale);
    expect(far).toEqual({ city: 1, district: 0, file: 0 });
    expect(mid.district).toBeGreaterThan(0.9);
    expect(near).toEqual({ city: 0, district: 0, file: 1 });
  });

  it('cross-fades at a threshold instead of popping', () => {
    const at = lodMix(th.far, scale);
    expect(at.city).toBeGreaterThan(0);
    expect(at.city).toBeLessThan(1);
    expect(at.district).toBeGreaterThan(0);
    let last = 2;
    for (let d = th.near / 4; d < th.far * 4; d *= 1.05) {
      const m = lodMix(d, scale);
      expect(m.file).toBeLessThanOrEqual(last + 1e-9); // monotonic: no level flickers back
      last = m.file;
    }
  });

  it('hands an empty level’s range to the next finer one', () => {
    // one city: no city ribbons, so district ribbons hold from afar
    expect(lodMix(th.far * 10, scale, { city: false, district: true })).toEqual({ city: 0, district: 1, file: 0 });
    // one district: files everywhere
    expect(lodMix(th.far * 10, scale, { city: false, district: false })).toEqual({ city: 0, district: 0, file: 1 });
  });

  it('counts a territory as in view when it overlaps the view circle', () => {
    const view = viewCircle({ x: 0, z: 0 }, 100);
    expect(inView(view, view.r + 20, 0, 30)).toBe(true);
    expect(inView(view, view.r + 40, 0, 30)).toBe(false);
  });
});

describe('edge budget', () => {
  it('keeps the strongest edges first and respects the cap', () => {
    const strength = [0.2, 0.9, 0.5, 0.9, 0.1, 0.7];
    expect(strongestFirst(strength, 3)).toEqual([1, 3, 5]);
    expect(strongestFirst(strength, 100)).toHaveLength(strength.length);
    expect(strongestFirst(strength, 2, [4, 0, 2])).toEqual([2, 0]); // among candidates only
    expect(strongestFirst(strength, 0)).toEqual([]);
  });

  it('never hands out more than the budget, in priority order', () => {
    const budget = config.render.edgeBudget;
    const got = allocateBudget(budget, [budget - 10, 40, 500, 1500]);
    expect(got).toEqual([budget - 10, 10, 0, 0]);
    expect(got.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(budget);
    expect(allocateBudget(100, [10, 20, 30])).toEqual([10, 20, 30]);
  });
});
