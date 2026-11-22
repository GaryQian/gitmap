import { describe, expect, it } from 'vitest';
import { config } from '../config';
import { createModelStore, edgeId, type Layer, type StructureTables } from '../model';
import { tablesToOps } from '../testing/synthetic';
import { LAYER_DEFS, OVERLAYS, OVERLAY_RAMP, RECENCY_OLDER, buildAdjacency, computeReach, legendFor, overlayView, ownershipShare, type OverlayId, type OwnershipExtra } from './index';

/** Units a..f in one district with the given dependency edges (src depends on dst). */
function model(ids: string[], edges: [string, string][]) {
  const tables: StructureTables = {
    city: { ids: ['c'], cols: { name: ['c'] } },
    district: { ids: ['d'], cols: { city: ['c'], name: ['d'] } },
    unit: { ids, cols: { primaryFile: ids, district: ids.map(() => 'd') } },
    file: { ids, cols: { unit: ids } },
    edge: { ids: edges.map(([s, d]) => edgeId(s, d)), cols: { src: edges.map((e) => e[0]), dst: edges.map((e) => e[1]) } },
  };
  const store = createModelStore();
  store.propose(tablesToOps(tables));
  return store;
}

describe('dependency reach', () => {
  // a → b → c → d, a → c, e → b; f is isolated
  const store = model(['a', 'b', 'c', 'd', 'e', 'f'], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'c'], ['e', 'b']]);
  const replica = store.replica, units = replica.table('unit');
  const slot = (id: string) => units.slotOf(id);
  const hops = (seeds: string[], direction: 'dependsOn' | 'dependedOnBy', max?: number) => {
    const reach = computeReach(buildAdjacency(replica), seeds.map(slot), direction, max);
    return Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [id, reach[slot(id)]]));
  };

  it('counts hops along dependencies', () => {
    expect(hops(['a'], 'dependsOn')).toEqual({ a: 0, b: 1, c: 1, d: 2, e: NaN, f: NaN });
  });

  it('counts hops back along dependents', () => {
    expect(hops(['c'], 'dependedOnBy')).toEqual({ a: 1, b: 1, c: 0, d: NaN, e: 2, f: NaN });
  });

  it('takes several seeds and a hop limit', () => {
    expect(hops(['a', 'e'], 'dependsOn', 1)).toEqual({ a: 0, b: 1, c: 1, d: NaN, e: 0, f: NaN });
  });

  it('follows the replica after edges change', () => {
    store.propose([{ op: 'remove', kind: 'edge', rows: { ids: [edgeId('a', 'c')], cols: {} } }]);
    expect(hops(['a'], 'dependsOn')).toEqual({ a: 0, b: 1, c: 2, d: 3, e: NaN, f: NaN });
  });
});

describe('ownership share', () => {
  it('is the contributor\'s part of each unit\'s commits, NaN without history', () => {
    const store = model(['a', 'b', 'c'], []);
    const extra: OwnershipExtra = {
      unitIds: ['b', 'a'], offsets: [0, 2, 3], authorIds: [1, 2, 2], authorCommits: [3, 1, 5],
      contributors: [{ id: 2, name: 'Bo', commits: 6 }, { id: 1, name: 'Ada', commits: 3 }],
    };
    const units = store.replica.table('unit');
    const share = (who: number) => { const s = ownershipShare({ extra }, who, store.replica); return ['a', 'b', 'c'].map((id) => s[units.slotOf(id)]); };
    expect(share(1)).toEqual([0, 0.75, NaN]);
    expect(share(2)).toEqual([1, 0.25, NaN]);
    expect(ownershipShare(null, 1, store.replica).every(Number.isNaN)).toBe(true);
  });
});

describe('overlayView', () => {
  const store = model(['a', 'b', 'c', 'd'], [['a', 'b']]);
  const replica = store.replica, units = replica.table('unit');
  const NOW = 1_800_000_000, DAY = 86400;
  const layerOf = (id: Exclude<OverlayId, 'reach'>, values: number[], extra?: Record<string, unknown>): Layer =>
    ({ def: LAYER_DEFS[id], status: 'partial', coverage: 0.5, values: Float32Array.from(values), extra });
  const at = (values: Float32Array, id: string) => values[units.slotOf(id)];

  it('returns sorted stops and keeps NaN for the renderer\'s unknown style, in both modes, for every overlay', () => {
    for (const mode of ['dark', 'light'] as const) {
      for (const { id } of OVERLAYS) {
        const view = overlayView(id, { replica, mode, seeds: ['u:a'], now: NOW });
        expect(view.id).toBe(id);
        expect(view.values.length).toBe(units.capacity);
        expect(view.stops.length).toBeGreaterThan(1);
        for (let i = 1; i < view.stops.length; i++) expect(view.stops[i].t).toBeGreaterThan(view.stops[i - 1].t);
        expect(view.stops[0].t).toBe(0);
        expect(view.stops[view.stops.length - 1].t).toBe(1);
        for (const s of view.stops) expect(s.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(view.unknown).toMatch(/^#[0-9a-f]{6}$/i);
        // "not yet known" is neither the faded end nor the background
        expect(view.stops.map((s) => s.color.toLowerCase())).not.toContain(view.unknown.toLowerCase());
        expect(view.unknown.toLowerCase()).not.toBe(config.theme[mode].void.toLowerCase());
        // no layer yet: every unit is unknown (reach: everything but the seed's reach)
        if (id !== 'reach') expect(view.values.every(Number.isNaN)).toBe(true);
        expect(legendFor(view).stops).toEqual(view.stops);
      }
    }
  });

  it('lists the overlays in the configured order', () => {
    expect(OVERLAYS.map((o) => o.id)).toEqual(config.overlays.enabled);
  });

  it('recency falls off fast: newer is brighter, "older than the window" is the faded end, unknown stays NaN', () => {
    const values = [NOW - DAY, NOW - 30 * DAY, RECENCY_OLDER, NaN];
    const view = overlayView('recency', { replica, mode: 'dark', layer: layerOf('recency', values), now: NOW });
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => at(view.values, id));
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(1);
    expect(c).toBe(0);
    expect(d).toBeNaN();
    expect(view.domain).toEqual([0, 1]);
    expect(view.status).toBe('partial');
    // steep: a file one half-life old is at half brightness, and one many half-lives old is all but faded
    const half = OVERLAY_RAMP.recencyHalfLifeSeconds;
    const steep = overlayView('recency', { replica, mode: 'dark', layer: layerOf('recency', [NOW, NOW - half, NOW - 8 * half, NaN]), now: NOW });
    expect(at(steep.values, 'a')).toBeCloseTo(1, 5);
    expect(at(steep.values, 'b')).toBeCloseTo(0.5, 5);
    expect(at(steep.values, 'c')).toBeLessThan(0.01);
    expect(steep.labels.high).toBe('Now');
    // a dormant repo is measured from its latest change, and the legend says so
    const dormant = overlayView('recency', { replica, mode: 'dark', layer: layerOf('recency', [NOW - 400 * DAY, NOW - 400 * DAY - half, NaN, NaN]), now: NOW });
    expect(at(dormant.values, 'a')).toBeCloseTo(1, 5);
    expect(at(dormant.values, 'b')).toBeCloseTo(0.5, 5);
    expect(dormant.labels.high).toMatch(/^Latest change, /);
  });

  it('ownership shows the chosen contributor, the top one by default', () => {
    const extra: OwnershipExtra = {
      unitIds: ['a', 'b'], offsets: [0, 2, 3], authorIds: [1, 2, 2], authorCommits: [1, 3, 4],
      contributors: [{ id: 2, name: 'Bo', commits: 7 }, { id: 1, name: 'Ada', commits: 1 }],
    };
    const layer = layerOf('ownership', [4, 4, NaN, NaN], extra);
    const top = overlayView('ownership', { replica, mode: 'dark', layer });
    expect([at(top.values, 'a'), at(top.values, 'b'), at(top.values, 'c')]).toEqual([0.75, 1, NaN]);
    expect(top.labels.high).toContain('Bo');
    const ada = overlayView('ownership', { replica, mode: 'dark', layer, contributorId: 1 });
    expect([at(ada.values, 'a'), at(ada.values, 'b')]).toEqual([0.25, 0]);
  });

  it('tests is discrete with one stop per category; reach puts the seed at the hot end', () => {
    const tests = overlayView('tests', { replica, mode: 'dark', layer: layerOf('tests', [0, 1, 2, NaN]) });
    expect(tests.discrete).toBe(true);
    expect(tests.stops.map((s) => s.t)).toEqual([0, 0.5, 1]);
    expect(tests.domain).toEqual([0, 2]);
    expect(legendFor(tests).categories.map((c) => c.color)).toEqual(tests.stops.map((s) => s.color));

    const reach = overlayView('reach', { replica, mode: 'dark', seeds: ['u:a'], direction: 'dependsOn' });
    expect([at(reach.values, 'a'), at(reach.values, 'b'), at(reach.values, 'c')]).toEqual([0, 1, NaN]);
    expect(reach.domain[0]).toBe(0);
    expect(reach.domain[1]).toBeGreaterThan(1);
  });
});
