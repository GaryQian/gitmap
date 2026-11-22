import { describe, expect, it } from 'vitest';
import { config } from '../config';
import { createModelStore, edgeId, type Layer, type StructureTables } from '../model';
import { tablesToOps } from '../testing/synthetic';
import { LAYER_DEFS, OVERLAYS, RECENCY_OLDER, buildAdjacency, computeReach, legendFor, overlayFact, overlayView, ownershipShare, recencyCutoffAt, recencyPositionOf, type OverlayId, type OwnershipExtra } from './index';

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

  it('recency spans newest to oldest file on a log scale, and hovering tells the age', () => {
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
    // the ends are the newest and oldest files, whatever their ages; the log scale falls off fast
    const span = overlayView('recency', { replica, mode: 'dark', layer: layerOf('recency', [NOW, NOW - DAY, NOW - 1000 * DAY, NaN]), now: NOW });
    expect(at(span.values, 'a')).toBeCloseTo(1, 5);
    expect(at(span.values, 'c')).toBeCloseTo(0, 5);
    expect(at(span.values, 'b')).toBeLessThan(0.7);   // one day out of a thousand already loses a third
    expect(at(span.values, 'b')).toBeGreaterThan(0.2);
    expect(span.labels.high).toBe('Newest, now');
    expect(span.labels.low).toBe('Oldest, 3 years ago');
    // a dormant repo still spans the whole ramp
    const dormant = overlayView('recency', { replica, mode: 'dark', layer: layerOf('recency', [NOW - 400 * DAY, NOW - 800 * DAY, NaN, NaN]), now: NOW });
    expect(at(dormant.values, 'a')).toBeCloseTo(1, 5);
    expect(at(dormant.values, 'b')).toBeCloseTo(0, 5);
    expect(dormant.labels.high).toBe('Newest, 13 months ago');
    // hovering tells the age
    const hovered = { ...replica, layers: new Map([['recency', layerOf('recency', [NOW - 3 * DAY, RECENCY_OLDER, NaN, NaN])]]) } as unknown as typeof replica;
    expect(overlayFact(span, hovered, units.slotOf('a'), NOW)).toBe('Last changed 3 days ago');
    expect(overlayFact(span, hovered, units.slotOf('b'), NOW)).toBe('Last changed before the history walked');
    expect(overlayFact(span, hovered, units.slotOf('c'), NOW)).toBe('Age not yet known');
  });

  it('recency leaves out files older than the age filter and ends the scale there', () => {
    const values = [NOW, NOW - 2 * DAY, NOW - 40 * DAY, RECENCY_OLDER];
    const layer = layerOf('recency', values);
    const all = overlayView('recency', { replica, mode: 'dark', layer, now: NOW });
    expect(all.recency).toEqual({ spanSeconds: 40 * DAY, hidden: 0 });

    const cut = overlayView('recency', { replica, mode: 'dark', layer, now: NOW, maxAgeSeconds: 10 * DAY });
    expect(at(cut.values, 'a')).toBeCloseTo(1, 5);
    expect(at(cut.values, 'c')).toBe(-Infinity);          // 40 days behind the newest: off the map
    expect(at(cut.values, 'd')).toBe(-Infinity);          // older than the history walked: off too
    expect(cut.recency).toEqual({ spanSeconds: 40 * DAY, hidden: 2 });
    // the scale now ends at the cut-off: a file is placed by its age against ten days, not forty
    expect(at(cut.values, 'b')).toBeCloseTo(1 - Math.log1p((2 * DAY) / 60) / Math.log1p((10 * DAY) / 60), 5);
    expect(cut.labels.low).toBe('Oldest shown, 10 days ago');
    // and the narrower the window, the greener the ramp starts: the oldest file shown is no longer grey
    const grey = all.stops[0].color;
    const narrow = overlayView('recency', { replica, mode: 'dark', layer, now: NOW, maxAgeSeconds: 3 * DAY });
    expect(all.stops).toHaveLength(3);
    expect(cut.stops[0].color).not.toBe(grey);
    expect(narrow.stops[0].color).not.toBe(cut.stops[0].color);
    expect(cut.stops[cut.stops.length - 1].color.toLowerCase()).toBe(all.stops[2].color.toLowerCase());
    const green = (hex: string) => parseInt(hex.slice(3, 5), 16) - parseInt(hex.slice(1, 3), 16);
    expect(green(cut.stops[0].color)).toBeGreaterThan(green(grey));
    expect(green(narrow.stops[0].color)).toBeGreaterThan(green(cut.stops[0].color));
    // a cut-off beyond the oldest file changes nothing
    const wide = overlayView('recency', { replica, mode: 'dark', layer, now: NOW, maxAgeSeconds: 400 * DAY });
    expect(Array.from(wide.values)).toEqual(Array.from(all.values));
    expect(wide.labels.low).toBe(all.labels.low);
  });

  it('spreads the age slider over the logarithm of the age', () => {
    const span = 1000 * DAY;
    expect(recencyCutoffAt(0, span)).toBeCloseTo(DAY, 6);
    expect(recencyCutoffAt(1, span)).toBe(Infinity);
    // a third of the slider is the first ten days, two thirds the first hundred
    expect(recencyCutoffAt(1 / 3, span)).toBeCloseTo(10 * DAY, 3);
    expect(recencyCutoffAt(2 / 3, span)).toBeCloseTo(100 * DAY, 2);
    for (const p of [0, 0.2, 0.5, 0.9]) expect(recencyPositionOf(recencyCutoffAt(p, span), span)).toBeCloseTo(p, 9);
    expect(recencyPositionOf(Infinity, span)).toBe(1);
    expect(recencyPositionOf(span * 2, span)).toBe(1);
    // a map whose files all changed within a day has nothing to cut
    expect(recencyCutoffAt(0.5, DAY / 2)).toBe(Infinity);
    expect(recencyPositionOf(3600, DAY / 2)).toBe(1);
  });

  it('ownership shows the chosen contributor, the top one by default', () => {
    const extra: OwnershipExtra = {
      unitIds: ['a', 'b'], offsets: [0, 2, 3], authorIds: [1, 2, 2], authorCommits: [1, 3, 4],
      contributors: [{ id: 2, name: 'Bo', commits: 7 }, { id: 1, name: 'Ada', commits: 1 }],
    };
    const layer = layerOf('ownership', [4, 4, NaN, NaN], extra);
    const top = overlayView('ownership', { replica, mode: 'dark', layer });
    // any share at all starts at the purple floor; none stays at the grey end
    expect(at(top.values, 'a')).toBeCloseTo(0.1 + 0.9 * 0.75, 5);
    expect(at(top.values, 'b')).toBe(1);
    expect(at(top.values, 'c')).toBeNaN();
    expect(top.labels.high).toContain('Bo');
    const ada = overlayView('ownership', { replica, mode: 'dark', layer, contributorId: 1 });
    expect(at(ada.values, 'a')).toBeCloseTo(0.1 + 0.9 * 0.25, 5);
    expect(at(ada.values, 'b')).toBe(0);
    expect(overlayFact(ada, replica, units.slotOf('a'))).toBe('25% of commits by Ada');
    expect(overlayFact(ada, replica, units.slotOf('b'))).toBe('No commits by Ada');
    expect(overlayFact(top, replica, units.slotOf('b'))).toBe('100% of commits by Bo');
  });

  it('tests is discrete with one stop per category; reach puts the seed at the hot end', () => {
    // a is a test and b the file it references; c and d are uncovered in the layer. The overlay
    // splits those by the unit graph: d, which b depends on, is one hop from a tested file.
    const linked = model(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'd']]).replica;
    const slotIn = (id: string) => linked.table('unit').slotOf(id);
    const tests = overlayView('tests', { replica: linked, mode: 'dark', layer: layerOf('tests', [0, 1, 2, 2]) });
    expect(tests.discrete).toBe(true);
    expect(tests.stops.map((s) => s.t)).toEqual([0, 1 / 3, 2 / 3, 1]);
    expect(tests.domain).toEqual([0, 3]);
    expect(['a', 'b', 'c', 'd'].map((id) => tests.values[slotIn(id)])).toEqual([0, 1, 3, 2]);
    expect(legendFor(tests).categories.map((c) => c.color)).toEqual(tests.stops.map((s) => s.color));
    expect(overlayFact(tests, linked, slotIn('b'))).toBe('Referenced by a test');
    expect(overlayFact(tests, linked, slotIn('c'))).toBe('No tested file within a hop');
    expect(overlayFact(tests, linked, slotIn('d'))).toBe('One hop from a tested file');
    // the link counts in either direction, and a unit that is not code stays unknown
    const uses = model(['a', 'b', 'c', 'd'], [['a', 'b'], ['c', 'b']]).replica;
    const other = overlayView('tests', { replica: uses, mode: 'dark', layer: layerOf('tests', [0, 1, 2, NaN]) });
    expect(other.values[uses.table('unit').slotOf('c')]).toBe(2);
    expect(other.values[uses.table('unit').slotOf('d')]).toBeNaN();
    const risk = overlayView('knowledgeRisk', { replica, mode: 'dark', layer: layerOf('knowledgeRisk', [0.82, NaN, NaN, NaN]) });
    expect(overlayFact(risk, replica, units.slotOf('a'))).toBe('Top author made 82% of commits');

    const reach = overlayView('reach', { replica, mode: 'dark', seeds: ['u:a'], direction: 'dependsOn' });
    expect([at(reach.values, 'a'), at(reach.values, 'b'), at(reach.values, 'c')]).toEqual([0, 1, NaN]);
    expect(reach.domain[0]).toBe(0);
    expect(reach.domain[1]).toBeGreaterThan(1);
    expect(overlayFact(reach, replica, units.slotOf('a'))).toBe('In the selection');
    expect(overlayFact(reach, replica, units.slotOf('b'))).toBe('1 hop from the selection');
    expect(overlayFact(reach, replica, units.slotOf('c'))).toBe('Not a dependency');
    const limited = overlayView('reach', { replica, mode: 'dark', seeds: ['u:a'], direction: 'dependsOn', maxHops: 2 });
    expect(overlayFact(limited, replica, units.slotOf('c'))).toBe('Not a dependency within 2 hops');
  });
});
