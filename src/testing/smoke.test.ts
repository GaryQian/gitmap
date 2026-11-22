import { describe, expect, it } from 'vitest';
import { config } from '../config';
import { createReplica } from '../model';
import { plugins } from '../lang';
import { createStaticPhysics } from './staticPhysics';
import { syntheticBatch } from './synthetic';

describe('round 0 skeleton', () => {
  it('loads and validates config.json', () => {
    expect(config.app.title).toBeTruthy();
  });

  it('applies a synthetic full batch to a replica and lays it out', async () => {
    const batch = syntheticBatch({ files: 300, seed: 3 });
    const replica = createReplica();
    expect(replica.apply(batch)).toBe(true);
    expect(replica.table('unit').count).toBe(300);
    expect(replica.table('edge').count).toBeGreaterThan(100);
    expect(replica.apply({ rev: 9, baseRev: 7, ops: [] })).toBe(false);
    const physics = createStaticPhysics({ config, capacity: { units: 400, districts: 100, cities: 20 } });
    physics.applyBatch(batch);
    const layout = await physics.getLayout();
    expect(layout.unit.ids.length).toBe(300);
    expect(layout.unit.xz.every(Number.isFinite)).toBe(true);
  });

  it('discovers language plug-ins without a registry', () => {
    expect(Array.isArray(plugins)).toBe(true);
  });
});

import { IMAGE_LANG, maxUnitRadius, unitRadius, unitRadiusAt } from '../shared';

describe('unitRadius (PLAN.md §8.1)', () => {
  const v = config.visual;
  it('is set by size and only ever enlarged by importance', () => {
    for (const loc of [1, 10, 500, 5000, 100000]) {
      const base = unitRadius(loc, 0, v);
      expect(base).toBeGreaterThanOrEqual(v.radiusMin);
      expect(base).toBeLessThanOrEqual(v.radiusMax);
      expect(unitRadius(loc, 0.5, v)).toBeGreaterThanOrEqual(base);
      expect(unitRadius(loc, 1, v)).toBeCloseTo(base * (1 + v.importanceBoost), 6);
      expect(unitRadius(loc, 1, v)).toBeLessThanOrEqual(maxUnitRadius(v) + 1e-9);
    }
    expect(unitRadius(5000, 0, v)).toBeGreaterThan(unitRadius(50, 0, v));
  });

  it('sizes an image by its bytes and any other unit by its lines', () => {
    const cols = { loc: [0, 0, 120], bytes: [400 * v.imageBytesPerLine, 4 * v.imageBytesPerLine, 400 * v.imageBytesPerLine], lang: [IMAGE_LANG, IMAGE_LANG, 'ts'], importancePct: [0, 0, 0] };
    expect(unitRadiusAt(cols, 0, v)).toBeCloseTo(unitRadius(400, 0, v), 6);
    expect(unitRadiusAt(cols, 0, v)).toBeGreaterThan(unitRadiusAt(cols, 1, v));
    expect(unitRadiusAt(cols, 2, v)).toBeCloseTo(unitRadius(120, 0, v), 6);
  });
});
